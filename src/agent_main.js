/******************************************************************************
Copyright (c) 2012, Google Inc.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright notice,
      this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright notice,
      this list of conditions and the following disclaimer in the documentation
      and/or other materials provided with the distribution.
    * Neither the name of Google, Inc. nor the names of its contributors
      may be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
******************************************************************************/

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
  serverUrl: [String, null],
  location: [String, null],
  deviceAddr: [String, null],
  deviceSerial: [String, null],
  jobTimeout: [Number, null],
  apiKey: [String, null],
  port: [Number, null],
  resultDir: [String, null]
};

var WD_SERVER_EXIT_TIMEOUT = 5000;  // Wait for 5 seconds before force-killing
var WD_SCRIPT_TEMPLATE = " \
    driver = new webdriver.Builder().build(); \
    driver.get('%s'); \
    driver.sleep(3000); \
    driver.wait(function()  { return driver.getTitle();});";

/**
 * @param {wpt_client.Client} client the WebPagetest client.
 * @param {Object} flags from knownOpts.
 * @constructor
 */
function Agent(client, flags) {
  'use strict';
  this.client_ = client;
  this.flags_ = flags;
  this.httpServer = express();
  this.httpPort = flags.port ? flags.port : 8888;
  this.app_ = webdriver.promise.Application.getInstance();
  process_utils.injectWdAppLogging('main app', this.app_);
  this.wdServer_ = undefined;  // The wd_server child process.

  this.client_.onStartJobRun = this.startJobRun_.bind(this);
  this.client_.onJobTimeout = this.jobTimeout_.bind(this);

  this.staticDir = './static/';
  this.startDate = moment();
}
/** Public class. */
exports.Agent = Agent;

/**
 * Runs jobs that it receives from the client.
 */
Agent.prototype.run = function() {
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
  this.httpServer.get('/task/result/:id/:filename', this.showTaskResult.bind(this));
  this.httpServer.get('/task/result/:id/:filename/stat', this.statTaskResult.bind(this));
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

Agent.prototype.healthz = function(req, res) {
  res.set('Content-Type', 'text/plain');
  res.send('ok');
};

Agent.prototype.varz = function(req, res) {
  res.set('Content-Type', 'text/plain');
  res.send('ok');
};

Agent.prototype.resolveIP = function(req, res) {
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

Agent.prototype.showCounter = function(req, res) {
  var counter = req.params.counter;
  res.set('Content-Type', 'text/plain');
  if (counter == 'pending_tasks') {
    res.send(this.client_.jobQueue.length);
  } else {
    res.send(404, 'Not found' + counter);
  }
};

Agent.prototype.showSummary = function(req, res) {

  var buf = [];
  buf.push('<html><body>');
  buf.push('Server start from: <strong>' +
           this.startDate.format('YYYY-MM-DD HH:mm:ss') +
           '</strong>; <strong>' + this.startDate.fromNow() + '</strong><br>');
  buf.push('Server current time: ' + moment().format('YYYY-MM-DD HH:mm:ss') + '<br>');

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

  for (var i = this.client_.finishedTasks.length - 1; i >= 0; --i) {
    var task = this.client_.finishedTasks[i];
    buf.push(common_utils.task2Html(task) + '<br>');
  }

  buf.push('</body></html>');

  res.set('Content-Type', 'text/html');
  res.send(buf.join('\n'));
};

/**
 * Typicall task contain following fields
 * var task = {
 *   "url":"",
 *   "runs": 1,
 *   "fvonly": 0,
 *   "proxyPacUrl": "",  //optional
 *   "proxyServer": "",  //optional
 *   "script":"driver = new
 *      webdriver.Builder().build();driver.get('http://www.baidu.com');
 *      driver.wait(function()  { return driver.getTitle();});", };
 */
Agent.prototype.submitTask = function(req, res) {
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
        return res.json(500, {'message': 'Duplicate gid.'});
      }
    }
  }

  task['submitTimestamp'] = moment().unix();
  if (!task.script) {
    if (task.url) {
      if (task.url.indexOf('http') != 0) {
        task.url = 'http://' + task.url;
      }
      task.script = util.format(WD_SCRIPT_TEMPLATE, task.url);
    } else {
      return res.json(501, {'message': 'No url or script.'});
    }
  }

  task.runs = (task.runs ? parseInt(task.runs) : 1);
  task.fvonly = (task.fvonly ? parseInt(task.fvonly) : 1);
  task.isCacheWarm = (task.isCacheWarm ? parseInt(task.isCacheWarm) : 0);
  task.tcpdump = (task.tcpdump ? parseInt(task.tcpdump) : 0);

  var id = this.client_.addTask(task);
  res.json({'id': id, 'position': this.client_.jobQueue.length});
};

Agent.prototype.showTaskStatus = function(req, res) {
  'use strict';
  res.set('Content-Type', 'application/json');
  var id = req.params.id;
  if (this.client_.currentJob_ && this.client_.currentJob_.id === id) {
    return res.json({'status': 'running'});
  }
  for (var i in this.client_.jobQueue) {
    var job = this.client_.jobQueue[i];
    if (job.id === id) {
      return res.json({'status': 'pending', 'position': i + 1});
    }
  }

  for (var i in this.client_.finishedTasks) {
    var task = this.client_.finishedTasks[i];
    if (task.id === id) {
      return res.json({'status': 'finished',
                       'success': task.success || false});
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
        return res.json({'status': 'finished',
                         'success': task.success || false});
      } else {
        res.json(500, 'Task record error: ' + data);
      }
    }
  });
};

Agent.prototype.showTaskQueue = function(req, res) {
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

Agent.prototype.showTaskResult = function(req, res) {
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

Agent.prototype.statTaskResult = function(req, res) {
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

Agent.prototype.listTaskResult = function(req, res) {
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
 * @param {string=} description debug title.
 * @param {Function} f the function to schedule.
 * @return {webdriver.promise.Promise} the scheduled promise.
 * @private
 */
Agent.prototype.scheduleNoFault_ = function(description, f) {
  'use strict';
  return process_utils.scheduleNoFault(this.app_, description, f);
};

/**
 * Starts a child process with the wd_server module.
 *
 * @private
 */
Agent.prototype.startWdServer_ = function() {
  'use strict';
  this.wdServer_ = child_process.fork('./src/wd_server.js',
      [], {env: process.env});
  this.wdServer_.on('exit', function(code, signal) {
    logger.info('wd_server child process exit code %s signal %s', code, signal);
    this.wdServer_ = undefined;
  }.bind(this));
};

/**
 * Processes job results, including failed jobs.
 *
 * @param {Object} ipcMsg a message from the wpt client.
 * @param {Job} job the job with results.
 * @private
 */
Agent.prototype.scheduleProcessDone_ = function(ipcMsg, job) {
  'use strict';
  this.scheduleNoFault_('Process job results', function() {
    if (ipcMsg.devToolsMessages) {
//      job.zipResultFiles['devtools.json'] =
//          JSON.stringify(ipcMsg.devToolsMessages);
      var devMessage = JSON.stringify(ipcMsg.devToolsMessages);
      job.resultFiles.push(
          new wpt_client.ResultFile(
              wpt_client.ResultFile.ContentType.JSON,
              'devtools.json', devMessage));
      var harJson = har.parseFromText(devMessage);
      job.processHAR(harJson);
      job.resultFiles.push(
          new wpt_client.ResultFile(
              wpt_client.ResultFile.ContentType.JSON,
              'har.json', JSON.stringify(harJson)));
    }
    if (ipcMsg.screenshots && ipcMsg.screenshots.length > 0) {
      var imageDescriptors = [];
      ipcMsg.screenshots.forEach(function(screenshot) {
        logger.debug('Adding screenshot %s', screenshot.fileName);
        var contentBuffer = new Buffer(screenshot.base64, 'base64');
        job.resultFiles.push(new wpt_client.ResultFile(
            wpt_client.ResultFile.ContentType.IMAGE_PNG,
            screenshot.fileName,
            contentBuffer));
        if (screenshot.description) {
          imageDescriptors.push({
            filename: screenshot.fileName,
            description: screenshot.description
          });
        }
      });
      if (imageDescriptors.length > 0) {
        job.zipResultFiles['images.json'] = JSON.stringify(imageDescriptors);
      }
    }
    if (ipcMsg.videoFile) {
      process_utils.scheduleFunction(this.app_, 'Read video file',
          fs.readFile, ipcMsg.videoFile).then(function(buffer) {
        job.resultFiles.push(new wpt_client.ResultFile(
            wpt_client.ResultFile.ContentType.IMAGE,
            'video.avi', buffer));
      }, function() { // ignore errors?
      });
      process_utils.scheduleFunction(this.app_, 'Delete video file',
          fs.unlink, ipcMsg.videoFile);
    }
  }.bind(this));
};

/**
 * Performs one run of a job in a wd_server module that runs as a child process.
 *
 * Must call job.runFinished() no matter how the run ended.
 *
 * @param {Job} job the job to run.
 * @private
 */
Agent.prototype.startJobRun_ = function(job) {
  'use strict';
//  job.isCacheWarm = !!this.wdServer_;
//  job.isCacheWarm = false;
  logger.info('Running job %s run %d/%d cacheWarm=%s',
      job.id, job.runNumber, job.runs, job.isCacheWarm);
  if (!this.wdServer_) {
    if (job.tcpdump) {
      job.startTCPDump();
    }
    this.startWdServer_();
    this.wdServer_.on('message', function(ipcMsg) {
      logger.debug('got IPC: %s', ipcMsg.cmd);
      if ('done' === ipcMsg.cmd || 'error' === ipcMsg.cmd) {
        var isRunFinished = job.isFirstViewOnly || job.isCacheWarm;
        if ('error' === ipcMsg.cmd) {
          job.error = ipcMsg.e;
          // Error in a first-view run: can't do a repeat run.
          isRunFinished = true;
        }
        this.scheduleProcessDone_(ipcMsg, job);
        if (isRunFinished) {
          this.scheduleCleanup_();
        }
        // Do this only at the very end, as it starts a new run of the job.
        this.scheduleNoFault_('Job finished',
            job.runFinished.bind(job, isRunFinished));
      }
    }.bind(this));
  }
  var script = job.task.script;
  var url = job.task.url;
  var pac;
  if (script && !/new\s+(\S+\.)?Builder\s*\(/.test(script)) {
    var urlAndPac = this.decodeUrlAndPacFromScript_(script);
    url = urlAndPac.url;
    pac = urlAndPac.pac;
  }
  url = url.trim();
  if (!((/^https?:\/\//i).test(url))) {
    url = 'http://' + url;
  }
  this.scheduleNoFault_('Send IPC "run"', function() {
    var message = {
        cmd: 'run',
        options: {browserName: job.task.browser},
        runNumber: job.runNumber,
        exitWhenDone: job.isFirstViewOnly || job.isCacheWarm,
        captureVideo: job.captureVideo,
        script: script,
        url: url,
        pac: pac,
        timeout: this.client_.jobTimeout - 15000  // 15 seconds to stop+submit.
      };
    if (job.task.proxyPacUrl) {
      message.proxyPacUrl = job.task.proxyPacUrl;
    } else if (job.task.proxyServer) {
      message.proxyServer = job.task.proxyServer;
    }
    var key;
    for (key in this.flags_) {
      if (!message[key]) {
        message[key] = this.flags_[key];
      }
    }
    this.wdServer_.send(message);
  }.bind(this));
};

/**
 * @param {string} message the error message.
 * @constructor
 * @see decodeUrlAndPacFromScript_
 */
function ScriptError(message) {
  'use strict';
  this.message = message;
  this.stack = (new Error(message)).stack;
}
ScriptError.prototype = new Error();

/**
 * Extract the URL and PAC from a simple WPT script.
 *
 * We don't support general WPT scripts.  Instead, we only support the minimal
 * subset that's required to express a PAC proxy configuration script.
 * Here are a couple examples of supported scripts:
 *
 *    1)
 *    setDnsName foo.com bar.com
 *    navigate qux.com
 *
 *    2)
 *    setDnsName foo.com ignored.com
 *    overrideHost foo.com bar.com
 *    navigate qux.com
 *
 * Blank lines and lines starting with "//" are ignored.  Lines starting with
 * "if", "endif", and "addHeader" are also ignored for now, but this feature is
 * deprecated and these commands will be rejected in a future.  Any other input
 * will throw a ScriptError.
 *
 * @param {string} script e.g.:
 *   setDnsName fromHost toHost
 *   navigate url.
 * @return {Object} a URL and PAC object, e.g.:
 *   {url:'http://x.com', pac:'function Find...'}.
 * @private
 */
Agent.prototype.decodeUrlAndPacFromScript_ = function(script) {
  'use strict';
  var fromHost, toHost, proxy, url;
  script.split('\n').forEach(function(line, lineNumber) {
    line = line.trim();
    if (!line || 0 === line.indexOf('//')) {
      return;
    }
    if (line.match(/^(if|endif|addHeader)\s/i)) {
      return;
    }
    var m = line.match(/^setDnsName\s+(\S+)\s+(\S+)$/i);
    if (m && !fromHost && !url) {
      fromHost = m[1];
      toHost = m[2];
      return;
    }
    m = line.match(/^overrideHost\s+(\S+)\s+(\S+)$/i);
    if (m && fromHost && m[1] === fromHost && !proxy && !url) {
      proxy = m[2];
      return;
    }
    m = line.match(/^navigate\s+(\S+)$/i);
    if (m && fromHost && !url) {
      url = m[1];
      return;
    }
    throw new ScriptError('WPT script contains unsupported line[' +
        lineNumber + ']: ' + line);
  });
  if (!fromHost || !url) {
    throw new ScriptError('WPT script lacks ' +
        (fromHost ? 'navigate' : 'setDnsName'));
  }
  logger.debug('Script is a simple PAC from=%s to=%s url=%s',
      fromHost, (proxy ? proxy : toHost), url);
  return {url: url, pac: 'function FindProxyForURL(url, host) {\n' +
      '  if ("' + fromHost + '" === host) {\n' +
      '    return "PROXY ' + (proxy ? proxy : toHost) + '";\n' +
      '  }\n' +
      '  return "DIRECT";\n}\n'};
};

/**
 * @param {Object} job the timed-out job to abort.
 * @private
 */
Agent.prototype.jobTimeout_ = function(job) {
  'use strict';
  if (this.wdServer_) {
    this.scheduleNoFault_('Send IPC "abort"', function() {
      this.wdServer_.send({cmd: 'abort'});
    }.bind(this));
  }
  job.task.success = false;
  if (job.tcpdump) job.stopTCPDump();
  this.scheduleCleanup_();
  this.scheduleNoFault_('Timed out job finished',
      job.runFinished.bind(job, /*isRunFinished=*/true));
};

/**
 * Kill the wdServer and traffic shaper.
 *
 * @private
 */
Agent.prototype.scheduleCleanup_ = function() {
  'use strict';
  if (this.wdServer_) {
    process_utils.scheduleWait(this.wdServer_, 'wd_server',
          WD_SERVER_EXIT_TIMEOUT).then(function() {
      // This assumes a clean exit with no zombies
      this.wdServer = undefined;
    }.bind(this), function() {
      process_utils.scheduleKill(this.app_, 'Kill wd_server',
          this.wdServer_);
      this.app_.schedule('undef wd_server', function() {
        this.wdServer_ = undefined;
      }.bind(this));
    }.bind(this));
  }
  // TODO kill dangling child processes
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
