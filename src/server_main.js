
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
var path = require('path');
var process_utils = require('process_utils');
var system_commands = require('system_commands');
var util = require('util');
var task_manager = require('task_manager');
var wd_client = require('wd_client');

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
function WebServer(taskMgrList, flags) {
  'use strict';
  this.taskMgrList_ = taskMgrList;
  this.flags_ = flags;
  this.httpServer = express();
  this.httpPort = flags.port ? flags.port : 8888;

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
  this.httpServer.use('/archive',
                      express.static(task_manager.DEFAULT_BASE_RESULT_DIR));
  this.httpServer.use('/archive',
                      express.directory(task_manager.DEFAULT_BASE_RESULT_DIR));

  process.on('uncaughtException', function(err) {
    console.error(err);
    if (err && (err.errno == 'EADDRINUSE' || err.errno == 'EACCES')) {
      console.error('Http server run failed: ' + err.errno);
      process.exit(1);
    }
  });

  console.log('Start HTTP server with port=' + this.httpPort);
  this.httpServer.listen(this.httpPort);
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

WebServer.prototype.getRunningTasks_ = function() {
  var running = [];
  for (var i = this.taskMgrList_.length - 1; i >= 0; i--) {
    running = running.concat(this.taskMgrList_[i].runningQueue);
  };
  return running;
}

WebServer.prototype.getPendingTasks_ = function() {
  var pending = [];
  for (var i = this.taskMgrList_.length - 1; i >= 0; i--) {
    pending = pending.concat(this.taskMgrList_[i].pendingQueue);
  };
  return pending;
}

WebServer.prototype.getFinishedTasks_ = function() {
  var finished = [];
  for (var i = this.taskMgrList_.length - 1; i >= 0; i--) {
    finished = finished.concat(this.taskMgrList_[i].finishedQueue);
  };
  return finished;
}

WebServer.prototype.getTaskManager_ = function(taskDef) {
  // Default client task manager.
  var taskMgr = this.taskMgrList_[0];
  // Use the right task manager if specified.
  if (taskDef.client) {
    for (var i = 0; i < this.taskMgrList_.length; i++) {
      if (this.taskMgrList_[i].name == taskDef.client) {
        taskMgr = this.taskMgrList_[i];
      }
    };
  };
  return taskMgr;
}

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

  var runningTasks = this.getRunningTasks_();
  var pendingTasks = this.getPendingTasks_();
  var finishedTasks = this.getFinishedTasks_();

  buf.push('<strong>Running Jobs:</strong> <a href="/static/submit.html"' +
           ' target=_blank>Submit Test</a><br>');
  var i = 0;
  for (i = runningTasks.length - 1; i >= 0; i--) {
    buf.push(common_utils.task2Html(runningTasks[i].taskDef) + '<br>');
  };

  buf.push('<strong>Waiting Jobs:</strong>' + pendingTasks.length +'<br>');

  for (i = pendingTasks.length - 1; i >= 0; i--) {
    buf.push(common_utils.task2Html(pendingTasks[i].taskDef) + '<br>');
  };


  buf.push('<strong>Finished Jobs:</strong>(Recent ' +
           finishedTasks.length + ')<br>');

  for (i = finishedTasks.length - 1; i >= 0; --i) {
    buf.push(common_utils.task2Html(finishedTasks[i].taskDef) + '<br>');
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
  var taskDef = req.body;
  if (!(taskDef.url || taskDef.script)) {
    taskDef = req.query;
  }

  taskDef.submitTimestamp = moment().unix();
  if (!taskDef.script) {
    if (taskDef.url) {
      if (taskDef.url.indexOf('http') !== 0) {
        taskDef.url = 'http://' + taskDef.url;
      }
      taskDef.script = util.format(WD_SCRIPT_TEMPLATE, taskDef.url);
    } else {
      res.json(501, {'message': 'No url or script.'});
      return;
    }
  }

  taskDef.isCacheWarm = (taskDef.isCacheWarm ?
                         parseInt(taskDef.isCacheWarm, 10) : 0);
  taskDef.tcpdump = (taskDef.tcpdump ? parseInt(taskDef.tcpdump, 10) : 0);

  var taskMgr = this.getTaskManager_(taskDef);

  var ret = taskMgr.addTask(taskDef);
  if (ret.error) {
    res.json(500, ret);
  } else {
    res.json(ret);
  }
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

  var task;

  for (var i = 0; i < this.taskMgrList_.length; i++) {
    task = this.taskMgrList_[i].findTask(id);
  };

  // Not in memory queue.
  if (!task) {
    var taskDir = task_manager.Task.deduceResultDir(id);
    var filepath = path.join(taskDir, 'task.json');

    fs.readFile(filepath, function(err, data) {
      if (err) {
        res.send(404, 'Not found anywhere.' + id);
      } else {
        var taskDef = JSON.parse(data);
        if (taskDef) {
          res.json({'status': task_manager.Task.Status.FINISHED,
                    'success': taskDef.success || false});
          return;
        } else {
          res.json(500, 'Task record error: ' + data);
          return;
        }
      }
    });
  } else {
    var status = task_manager.Task.Status.FINISHED;
    if (!task.isFinished()) {
      status = task.status;
    }
    res.json({'status': status});
  }

  if (!task) {
    res.send(404, 'Not found ' + id);
  } else {
    //Finished task
    if (task.status = task_manager.Task.Status.FINISHED) {
    } else {
      res.json({'status': task.status});
    }
  }
};

/**
 * Show the test job queue.
 *
 * @param {Object} req the request object.
 * @param {Object} res the response object.
 */
WebServer.prototype.showTaskQueue = function(req, res) {
  'use strict';
  var pending = this.getPendingTasks_();
  var buf = [];

  for (var i = 0; i < pending.length; i++) {
    buf[i] = pending[i].id + ' -> ' + JSON.stringify(pending[i].taskDef);
  };

  res.set('Content-Type', 'text/plain');
  res.send('Total tasks: ' + pending.length +
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

  var taskDir = task_manager.Task.deduceResultDir(id);
  var filepath = path.join(taskDir, filename);

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

  var filepath = task_manager.Task.deduceReusltFilePath(id, filename);

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

  var resultDir = task_manager.Task.deduceResultDir(id);

  fs.readdir(resultDir, function(err, files) {
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
 * main is called automatically if server_main is the node module called
 * directly which it should be.
 * @param  {Object} flags command line flags.
 */
exports.main = function(flags) {
  'use strict';
  if (!((/^v\d\.([^0]\d|[89])/).test(process.version))) {
    throw new Error('node version must be >0.8, not ' + process.version);
  }
  exports.setSystemCommands();
  delete flags.argv; // Remove nopt dup

  var taskMgrList = [];
  var wd_manager = new task_manager.TaskManager('chrome',
                                            wd_client.WebDriverClient, flags);
  wd_manager.run();
  taskMgrList.push(wd_manager);

  var webServer = new WebServer(taskMgrList, flags);
  webServer.run();
};

if (require.main === module) {
  try {
    exports.main(nopt(knownOpts, {}, process.argv, 2));
  } catch (e) {
    console.log(e.stack);

    logger.error('%j', e);
    process.exit(-1);
  }
}
