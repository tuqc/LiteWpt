
var async = require('async');
var child_process = require('child_process');
var common_utils = require('common_utils');
var dns = require('dns');
var express = require('express');
var fs = require('fs');
var har = require('har');
var logger = require('logger');
var moment = require('moment');
var nopt = require('nopt');
var process_utils = require('process_utils');
var system_commands = require('system_commands');
var util = require('util');
var webdriver = require('webdriver');
var wpt_client = require('wpt_client');

/**
 * Partial list of expected command-line options.
 *
 * @see wd_server init defines additional command-line args, e.g.:
 *     browser: [String, null],
 *     chromedriver: [String, null],
 *     ..
 */
var knownOpts = {
  jobTimeout: [Number, null],
  port: [Number, null],
  resultDir: [String, null]
};

// Wait for 5 seconds before force-killing
var WD_SERVER_EXIT_TIMEOUT = 5000;

/*jslint multistr: true */
var WD_SCRIPT_TEMPLATE = 'driver = new webdriver.Builder().build();' +
    "driver.get('%s');" +
    'driver.sleep(3000);' +
    'driver.wait(function()  { return driver.getTitle();});';

/**
 * @param {wpt_client.Client} client the WebPagetest client.
 * @param {Object} flags from knownOpts.
 * @constructor
 */
function WebServer(client, flags) {
  'use strict';
  this.client_ = client;
  this.flags_ = flags;
  this.httpServer = express();
  this.httpPort = flags.port ? flags.port : 8888;
  process_utils.injectWdAppLogging('main app', this.app_);

  this.staticDir = './static/';
  this.startDate = moment();
}
/** Public class. */
exports.WebServer = WebServer;

/**
 * Runs jobs that it receives from the client.
 */
WebServer.prototype.run = function() {
  'use strict';

  // Http paths
  this.httpServer.use(express.bodyParser());
  this.httpServer.use(express.compress());
  this.httpServer.get('/', this.showSummary.bind(this));
  this.httpServer.get('/ip', this.resolveIP.bind(this));
  this.httpServer.get('/status/:counter', this.showCounter.bind(this));
  this.httpServer.get('/task/queue', this.showTaskQueue.bind(this));
  this.httpServer.get('/task/submit', this.submitTask.bind(this));
  this.httpServer.post('/task/submit', this.submitTask.bind(this));
  this.httpServer.get('/task/status/:id', this.showTaskStatus.bind(this));
  this.httpServer.get('/task/result/:id', this.listTaskResult.bind(this));
  this.httpServer.get('/task/result/:id/:filename',
                      this.showTaskResult.bind(this));
  this.httpServer.get('/task/result/:id/:filename/stat',
                      this.statTaskResult.bind(this));
  this.httpServer.get('/healthz', this.healthz.bind(this));
  this.httpServer.get('/varz', this.varz.bind(this));

  this.httpServer.use('/static', express.static(this.staticDir));
  this.httpServer.use('/archive', express.static(this.client_.resultDir));
  this.httpServer.use('/archive', express.directory(this.client_.resultDir));

  process.on('uncaughtException', function(err) {
    console.error(err);
    if (err && (err.errno == 'EADDRINUSE' || err.errno == 'EACCES')) {
      console.error('Http server run failed: ' + err.errno);
      process.exit(1);
    }
  });

  console.log('Start HTTP server with port=' + this.httpPort);
  this.httpServer.listen(this.httpPort);
  this.client_.run();
};

/**
 * Show the health.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.healthz = function(req, res) {
  res.set('Content-Type', 'text/plain');
  res.send('ok');
};

/**
 * Show the varz.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.varz = function(req, res) {
  res.set('Content-Type', 'text/plain');
  res.send('ok');
};

/**
 * Resolve hosts to IPs.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.resolveIP = function(req, res) {
  var host = req.query.host;
  if (!host) {
    res.send(500, '');
  }

  var hostList = host.trim().split(',');
  var resolveHost = function(host, callback) {
     dns.resolve4(host, function(err, addresses) {
      if (err || (!addresses)) {
        callback(err, null);
      } else {
        callback(null, [host, addresses[0]]);
      }
    });
  };

  async.map(hostList, resolveHost, function(err, results) {
    var resolvedResult = {};
    for (var i in results) {
      var pair = results[i];
      if (pair) {
        resolvedResult[pair[0]] = pair[1];
      }
    }
    res.json(resolvedResult);
  });
};

/**
 * Show the counters.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.showCounter = function(req, res) {
  var counter = req.params.counter;
  res.set('Content-Type', 'text/plain');
  if (counter == 'pending_tasks') {
    res.send(this.client_.jobQueue.length);
  } else {
    res.send(404, 'Not found' + counter);
  }
};

/**
 * Show the server summary.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.showSummary = function(req, res) {

  var buf = [];
  buf.push('<html><body>');
  buf.push('Server start from: <strong>' +
           this.startDate.format('YYYY-MM-DD HH:mm:ss') +
           '</strong>; <strong>' + this.startDate.fromNow() + '</strong><br>');
  buf.push('Server current time: ' +
           moment().format('YYYY-MM-DD HH:mm:ss') + '<br>');

  buf.push('<strong>Running Jobs:</strong> <a href="/static/submit.html"' +
           ' target=_blank>Submit Test</a><br>');
  if (this.client_.currentJob_) {
    buf.push(common_utils.task2Html(this.client_.currentJob_.task) + '<br>');
  }

  if (this.client_.jobQueue.length > 0) {
    buf.push('<strong>Waiting Jobs:</strong><br>');
  } else {
    buf.push('<strong>Waiting Jobs:</strong> None<br>');
  }

  for (var i in this.client_.jobQueue) {
      var job = this.client_.jobQueue[i];
      buf.push(common_utils.task2Html(job.task) + '<br>');
  }

  buf.push('<strong>Finished Jobs:</strong>(Recent ' +
           this.client_.finishedTasks.length + ')<br>');

  for (var k = this.client_.finishedTasks.length - 1; k >= 0; --k) {
    var task = this.client_.finishedTasks[k];
    buf.push(common_utils.task2Html(task) + '<br>');
  }

  buf.push('</body></html>');

  res.set('Content-Type', 'text/html');
  res.send(buf.join('\n'));
};

/**
 * Submit task. Typicall task contain following fields var
 * task = {
 *   "url":"",
 *   "runs": 1,
 *   "fvonly": 0,
 *   "proxyPacUrl": "",  //optional
 *   "proxyServer": "",  //optional
 *   "script":"driver = new
 *      webdriver.Builder().build();driver.get('http://www.baidu.com');
 *      driver.wait(function()  { return driver.getTitle();});", };
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.submitTask = function(req, res) {
  'use strict';
  res.set('Content-Type', 'application/json');
  var task = req.body;
  if (!(task.url || task.script)) {
    task = req.query;
  }

  // Gid short for group id, Here we don't allow 2 or more tasks
  // with the same gid in the pending list.
  if (task.gid) {
    var found = false;
    for (var i in this.client_.jobQueue) {
      var t = this.client_.jobQueue[i].task;
      if (t.gid && t.gid === task.gid) {
        res.json(500, {'message': 'Duplicate gid.'});
        return;
      }
    }
  }

  task.submitTimestamp = moment().unix();
  if (!task.script) {
    if (task.url) {
      if (task.url.indexOf('http') !== 0) {
        task.url = 'http://' + task.url;
      }
      task.script = util.format(WD_SCRIPT_TEMPLATE, task.url);
    } else {
      res.json(501, {'message': 'No url or script.'});
      return;
    }
  }

  task.runs = (task.runs ? parseInt(task.runs, 10) : 1);
  task.fvonly = (task.fvonly ? parseInt(task.fvonly, 10) : 1);
  task.isCacheWarm = (task.isCacheWarm ? parseInt(task.isCacheWarm, 10) : 0);
  task.tcpdump = (task.tcpdump ? parseInt(task.tcpdump, 10) : 0);

  var id = this.client_.addTask(task);
  res.json({'id': id, 'position': this.client_.jobQueue.length});
};

/**
 * Show the task status.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.showTaskStatus = function(req, res) {
  'use strict';
  res.set('Content-Type', 'application/json');
  var id = req.params.id;
  if (this.client_.currentJob_ && this.client_.currentJob_.id === id) {
    res.json({'status': 'running'});
    return;
  }
  for (var i in this.client_.jobQueue) {
    var job = this.client_.jobQueue[i];
    if (job.id === id) {
      res.json({'status': 'pending', 'position': i + 1});
      return;
    }
  }

  for (var k in this.client_.finishedTasks) {
    var task = this.client_.finishedTasks[k];
    if (task.id === id) {
      res.json({'status': 'finished',
                'success': task.success || false});
      return;
    }
  }

  var jobResult = this.client_.getJobResult(id);
  var filepath = jobResult.getResultFile('task.json');

  fs.readFile(filepath, function(err, data) {
    if (err) {
      res.send(404, 'Not found ' + id);
    } else {
      var task = JSON.parse(data);
      if (task) {
        res.json({'status': 'finished',
                  'success': task.success || false});
        return;
      } else {
        res.json(500, 'Task record error: ' + data);
        return;
      }
    }
  });
};

/**
 * Show the test job queue.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.showTaskQueue = function(req, res) {
  'use strict';
  var buf = [];
  for (var i in this.client_.jobQueue) {
    var job = this.client_.jobQueue[i];
    buf[i] = job.id + ' -> ' + JSON.stringify(job.task);
  }
  res.set('Content-Type', 'text/plain');
  res.send('Total tasks: ' + this.client_.jobQueue.length +
           '\n\n' + buf.join('\n\n'));
};

/**
 * Show the task result file.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.showTaskResult = function(req, res) {
  'use strict';
  var id = req.params.id;
  var filename = req.params.filename;

  var jobResult = this.client_.getJobResult(id);
  var filepath = jobResult.getResultFile(filename);

  fs.exists(filepath, function(exists) {
    if (exists) {
      if (req.query.view) {
        res.sendfile(filepath);
      } else {
        res.download(filepath);
      }
    } else {
      res.send(404, 'Sorry, cannot find file ' + filepath);
    }
  });
};

/**
 * Show the task file stat.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.statTaskResult = function(req, res) {
  'use strict';
  var id = req.params.id;
  var filename = req.params.filename;

  var jobResult = this.client_.getJobResult(id);
  var filepath = jobResult.getResultFile(filename);

  fs.stat(filepath, function(err, stats) {
    if (err) {
      res.json(404, {'exist': false});
    } else {
      res.json({'exist': true,
                'size': stats.size});
    }
  });
};

/**
 * List the task result files.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.listTaskResult = function(req, res) {
  'use strict';
  var id = req.params.id;

  var jobResult = this.client_.getJobResult(id);
  var filepath = jobResult.getResultDir();

  fs.readdir(filepath, function(err, files) {
    if (err) {
      res.send(404, err);
    } else {
      var buf = [];
      for (var i in files) {
        buf[i] = util.format(
            '<a href="/task/result/%s/%s?view=true" target=_blank>%s</a><br>',
            id, files[i], files[i]);
      }
      res.set('Content-Type', 'text/html');
      res.send(buf.join('\n'));
    }
  });
};


/**
 * Node.js is a multiplatform framework, however because we are making native
 * system calls, it becomes platform dependent. To reduce dependencies
 * throughout the code, all native commands are set here and when a command is
 * called through system_commands.get, the correct command for the current
 * platform is returned
 */
exports.setSystemCommands = function() {
  'use strict';
  process_utils.setSystemCommands();

  system_commands.set('run', './$0', 'unix');
  system_commands.set('run', '$0', 'win32');
};

/**
 * main is called automatically if agent_main is the node module called directly
 * which it should be. Main initializes the wpt_client Object with the flags
 * set by the run script and calls run with it
 *
 * @param  {Object} flags command line flags.
 */
exports.main = function(flags) {
  'use strict';
  if (!((/^v\d\.([^0]\d|[89])/).test(process.version))) {
    throw new Error('node version must be >0.8, not ' + process.version);
  }
  exports.setSystemCommands();
  delete flags.argv; // Remove nopt dup
  var client = new wpt_client.Client(flags);
  var agent = new Agent(client, flags);
  agent.run();
};

if (require.main === module) {
  try {
    exports.main(nopt(knownOpts, {}, process.argv, 2));
  } catch (e) {
    logger.error('%j', e);
    process.exit(-1);
  }
}
