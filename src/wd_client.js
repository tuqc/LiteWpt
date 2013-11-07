var async = require('async');
var child_process = require('child_process');
var common_utils = require('common_utils');
var events = require('events');
var fs = require('fs');
var fs_extra = require('fs-extra');
var har = require('har');
var http = require('http');
var isrunning = require('is-running');
var logger = require('logger');
var mkdirp = require('mkdirp');
var moment = require('moment');
var webdriver = require('selenium-webdriver');
var path = require('path');
var process_utils = require('process_utils');
var task_manager = require('task_manager');
var system_commands = require('system_commands');
var util = require('util');


var DEFAULT_TASK_TIMEOUT = 60000; // 60 seconds
// Wait for 5 seconds before force-killing
var WD_SERVER_EXIT_TIMEOUT = 5000;
// Temp directory for temp data.
var DEFAULT_TEMP_DIR = '/tmp/webtestserver/';

exports.WebDriverClient = WebDriverClient;

function WebDriverClient(clientMgr, task, flags) {
  'use strict';
  this.clientMgr = clientMgr;
  this.flags = flags;
  this.task = task;
  this.taskDef = task.taskDef;
  this.taskTimeout = task.timeout || DEFAULT_TASK_TIMEOUT;

  this.runTempDir_ = path.join(DEFAULT_TEMP_DIR, task.id);
  this.app_ = webdriver.promise.controlFlow();
  process_utils.injectWdAppLogging('main app', this.app_);
}

/**
 * Performs one run of a job in a wd_server module that runs as a child process.
 *
 */
WebDriverClient.prototype.run = function() {
  'use strict';
  if (!this.wdServer_) {
    this.startWdServer_();
  }

  process_utils.scheduleFunctionNoFault(this.app_,
            'Create ' + this.runTempDir_,
            mkdirp, this.runTempDir_);

  process_utils.scheduleFunctionNoFault(this.app_,
            'Create ' + this.task.getResultDir(),
            mkdirp, this.task.getResultDir());

  if (this.taskDef.tcpdump) {
      this.scheduleNoFault_('Start tcpdump',
                            this.task.startTCPDump.bind(this.task));
  }

  var script = this.taskDef.script;
  var url = this.taskDef.url;
  this.scheduleNoFault_('Send IPC "run"', function() {
    var message = {
        cmd: 'run',
        options: {browserName: this.taskDef.browser},
        exitWhenDone: true,
        script: script,
        url: url,
        runTempDir: this.runTempDir_,
        timeout: this.taskDef.timeout || DEFAULT_TASK_TIMEOUT
      };
    if (this.taskDef.proxyPacUrl) {
      message.proxyPacUrl = this.taskDef.proxyPacUrl;
    } else if (this.taskDef.proxyServer) {
      message.proxyServer = this.taskDef.proxyServer;
    }
    var key;
    for (key in this.flags) {
      if (!message[key]) {
        message[key] = this.flags[key];
      }
    }
    this.wdServer_.send(message);
  }.bind(this));
};


/**
 * @param {Object} abort test job.
 * @private
 */
WebDriverClient.prototype.taskTimeout_ = function() {
  'use strict';
  if (this.wdServer_) {
    this.scheduleNoFault_('Send IPC "abort"', function() {
      this.wdServer_.send({cmd: 'abort'});
    }.bind(this));
  }
  if (this.taskDef.tcpdump) this.stopTCPDump();
  this.scheduleNoFault_('Timed out job finished',
                        (this.clientMgr.runFinished(false, true)).bind(this));
  this.scheduleCleanup_();
};


/**
 * Finish task.
 * @private
 */
WebDriverClient.prototype.finishRun_ = function() {
  'use strict';
  logger.info('Finished run task %s.', this.task.id);
//  this.clientMgr.finishTask(this.task);
};


/**
 * Unhandled exception in the client process.
 *
 * @param {Error} e error object.
 * @private
 */
WebDriverClient.prototype.onUncaughtException_ = function(e) {
  'use strict';
  console.log(e.stack);
  logger.critical('Unhandled exception in the client: %s', e);
  this.task.setError(e);
};

/**
 * @param {string=} description debug title.
 * @param {Function} f the function to schedule.
 * @return {webdriver.promise.Promise} the scheduled promise.
 * @private
 */
WebDriverClient.prototype.scheduleNoFault_ = function(description, f) {
  'use strict';
  logger.info('Schedule no fault: %s', description);
  return process_utils.scheduleNoFault(this.app_, description, f);
};

/**
 * Starts a child process with the wd_server module.
 *
 * @private
 */
WebDriverClient.prototype.startWdServer_ = function() {
  'use strict';
  logger.info('Start wd server.');
  if (this.wdServer_) return;
  this.wdServer_ = child_process.fork('./src/wd_server.js',
      [], {env: process.env});

  this.wdServer_.on('message', function(ipcMsg) {
      logger.debug('got IPC: %s', ipcMsg.cmd);
      if ('done' === ipcMsg.cmd || 'error' === ipcMsg.cmd) {
        if ('error' === ipcMsg.cmd) {
          this.task.setError(ipcMsg.e);
        }
        this.scheduleProcessDone_(ipcMsg);
        this.scheduleCleanup_();

        this.scheduleNoFault_('Job finished',this.finishRun_.bind(this));
      }
    }.bind(this));

  this.wdServer_.on('exit', function(code, signal) {
    logger.info('wd_server child exit code %s signal %s', code, signal);
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
WebDriverClient.prototype.scheduleProcessDone_ = function(ipcMsg) {
  'use strict';
  logger.info('Schedule process done.');
  this.scheduleNoFault_('Process job results', function() {
    if (ipcMsg.devToolsMessages) {
      var devMessage = JSON.stringify(ipcMsg.devToolsMessages);
      this.task.addResultFile(task_manager.Task.ResultFileName.DEVTOOLS_MSG,
                              devMessage);
      var harJson = har.parseFromText(devMessage);
      this.task.processHAR(harJson);
      this.task.addResultFile(task_manager.Task.ResultFileName.HAR,
                              JSON.stringify(harJson));
    }
    logger.info('Screenshot number = %s', ipcMsg.screenshots.length);
    if (ipcMsg.screenshots && ipcMsg.screenshots.length > 0) {
      //Reverse the screenshots, because latest is more important.
      ipcMsg.screenshots.reverse();

      ipcMsg.screenshots.forEach(function(screenshot, index) {
        logger.info('Adding screenshot %s: %s', index, screenshot.diskPath);

        process_utils.scheduleFunctionNoFault(this.app_,
            'Read ' + screenshot.diskPath,
            fs.readFile, screenshot.diskPath).then(function(buffer) {
              var fileName = task_manager.Task.ResultFileName.SCREENSHOT;
              if (index >= 1) {
                var extname = path.extname(fileName);
                var basename = path.basename(fileName, extname);
                fileName = basename + '_' + index + extname;
              }
              this.task.addResultFile(fileName, buffer);
              index += 1;
            }.bind(this));
      }.bind(this));
    };
    this.scheduleNoFault_('Finishe task',
        this.clientMgr.finishTask.bind(this.clientMgr, this.task));
  }.bind(this));
};

/**
 * @param {Object} job the job to abort (e.g. due to timeout).
 * @private
 */
WebDriverClient.prototype.abort = function() {
  'use strict';
  logger.info('Abort task %s(%s)', this.task.id, this.task.status);
  if (this.task.isFinished()) {
    logger.warn('Task %s already aborted', this.task.id);
    return;
  }
  if (this.wdServer_) {
    this.scheduleNoFault_('Remove message listener',
      this.wdServer_.removeAllListeners.bind(this.wdServer_, 'message'));
    this.scheduleNoFault_('Send IPC "abort"',
        this.wdServer_.send.bind(this.wdServer_, {cmd: 'abort'}));
  }
  this.task.setStatus(task_manager.Task.Status.ABORTED);
  this.scheduleNoFault_('Finishe task',
     this.clientMgr.finishTask.bind(this.clientMgr, this.task));
  this.scheduleCleanup_();
  // this.scheduleNoFault_('Timed out job finished',
  //     job.runFinished.bind(job, /*isRunFinished=*/true));
};

/**
 * Makes sure the run temp dir exists and is empty, but ignores deletion errors.
 * Currently supports only flat files, no subdirectories.
 * @private
 */
WebDriverClient.prototype.scheduleCleanRunTempDir_ = function() {
  'use strict';
  logger.info('Start clean run temp directory.');
  process_utils.scheduleFunctionNoFault(this.app_, 'Tmp check',
      fs.exists, this.runTempDir_).then(function(exists) {
    if (exists) {
      process_utils.scheduleFunction(this.app_, 'Tmp read',
          fs.readdir, this.runTempDir_).then(function(files) {
        files.forEach(function(fileName) {
          var filePath = path.join(this.runTempDir_, fileName);
          process_utils.scheduleFunctionNoFault(this.app_,
              'Delete ' + filePath, fs.unlink, filePath);
        }.bind(this));
      }.bind(this));
    } else {
      process_utils.scheduleFunction(this.app_, 'Tmp create',
          fs.mkdir, this.runTempDir_);
    }
  }.bind(this));
  process_utils.scheduleFunction(this.app_, 'Remove dir ' + this. runTempDir_,
                                 fs.rmdir, this. runTempDir_)
};

/**
 * Kill the wdServer and traffic shaper.
 *
 * @private
 */
WebDriverClient.prototype.scheduleCleanup_ = function() {
  'use strict';
  logger.info('Start task clean up.');
  if (this.wdServer_) {
    this.scheduleNoFault_('Remove message listener',
        this.wdServer_.removeAllListeners.bind(this.wdServer_, 'message'));
    process_utils.scheduleWait(this.app_, this.wdServer_, 'wd_server',
          WD_SERVER_EXIT_TIMEOUT).then(function() {
      // This assumes a clean exit with no zombies
      this.wdServer = undefined;
    }.bind(this), function() {
      process_utils.scheduleKillTree(this.app_, 'Kill wd_server',
          this.wdServer_);
      this.app_.schedule('undef wd_server', function() {
        this.wdServer_ = undefined;
      }.bind(this));
    }.bind(this));
  }
  this.scheduleCleanRunTempDir_();
  // TODO kill dangling child processes
};
