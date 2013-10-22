var agent = require('agent');

function WebDriverAgent() {

}

util.inherits(WebDriverAgent, agent.Agent);


function WebDriverClient(task) {
  'use strict';
  events.EventEmitter.call(this);
  this.jobTimeout = task.jobTimeout || DEFAULT_JOB_TIMEOUT;
  this.handlingUncaughtException_ = undefined;

  exports.process.on('uncaughtException',
                     this.onUncaughtException_.bind(this));

  logger.extra('Created Client (urlPath=%s): %j', urlPath, this);
}

util.inherits(WebDriverClient, events.EventEmitter);
/** Allow test access. */
exports.WebDriverClient = WebDriverClient;

/**
 * @param {Job} job the job to start/continue.
 * @private
 */
WebDriverClient.prototype.startNextRun_ = function(job) {
  'use strict';
  job.error = undefined;  // Reset previous run's error, if any.
  // For comparison in finishRun_()
  this.currentJob_ = job;
  // Set up job timeout
  this.timeoutTimer_ = global.setTimeout(function() {
    logger.error('job timeout: %s, max=%s', job.id, this.jobTimeout);
    job.error = 'timeout';
    if (this.onJobTimeout) {
      this.onJobTimeout(job);
    } else {
      job.runFinished(/*isRunFinished=*/true);
    }
  }.bind(this), this.jobTimeout);

  if (this.onStartJobRun) {
    try {
      this.onStartJobRun(job);
    } catch (e) {
      logger.error('Exception while running the job: %s', e.stack);
      job.error = e.message;
      job.runFinished(/*isRunFinished=*/true);
    }
  } else {
    logger.critical('Client.onStartJobRun must be set');
    job.error = 'Agent is not configured to process jobs';
    job.runFinished(/*isRunFinished=*/true);
  }
};

/**
 * Ensures that the supposed job finished is actually the current one.
 * If it is, it will submit it so the results can be generated.
 * If a job times out and finishes later, finishRun_ will still be called,
 * but it will be handled and no results will be generated.
 *
 * @param {Object} job the job that supposedly finished.
 * @param {boolean} isRunFinished true if finished.
 * @private
 */
WebDriverClient.prototype.finishRun_ = function(job, isRunFinished) {
  'use strict';
  logger.alert('Finished run %s/%s (isRunFinished=%s) of job %s',
      job.runNumber, job.runs, isRunFinished, job.id);

  // Expected finish of the current job
  if (this.currentJob_ === job) {
    global.clearTimeout(this.timeoutTimer_);
    this.timeoutTimer_ = undefined;
    this.currentJob_ = undefined;

    this.handlingUncaughtException_ = undefined;
    // Run until we finish the last iteration.
    // Do not increment job.runNumber past job.runs.
    if (!(isRunFinished && job.runNumber === job.runs)) {
      // Continue running
      if (isRunFinished) {
        job.runNumber += 1;
        if (job.runNumber > job.runs) {  // Sanity check.
          throw new Error('Internal error: job.runNumber > job.runs');
        }
      }
      this.startNextRun_(job);
    } else {
      this.emit('done');
    }
  } else {  // Belated finish of an old already timed-out job
    logger.error('Timed-out job finished, but too late: %s', job.id);
    this.handlingUncaughtException_ = undefined;
  }
};


/**
 * Unhandled exception in the client process.
 *
 * @param {Error} e error object.
 * @private
 */
WebDriverClient.prototype.onUncaughtException_ = function(e) {
  'use strict';
  logger.critical('Unhandled exception in the client: %s', e);
  if (e) {
    logger.debug('%s', e.stack);
  }
  if (this.handlingUncaughtException_) {
    logger.critical(
        'Unhandled exception while handling another unhandled exception: %s',
        this.handlingUncaughtException_.message);
    // Stop handling an uncaught exception altogether
    this.handlingUncaughtException_ = undefined;
    // ...and we cannot do anything else, and we might stop working.
    // We could try to force-restart polling for jobs, not sure.
  } else if (this.currentJob_) {
    logger.critical('Unhandled exception while processing job %s',
        this.currentJob_.id);
    // Prevent an infinite loop for an exception while submitting job results.
    this.handlingUncaughtException_ = e;
    if (e) {
      this.currentJob_.error = e.message;
    }
    this.currentJob_.runFinished(/*isRunFinished=*/true);
  } else {
    logger.critical('Unhandled exception outside of job processing');
    // Not sure if we can do anything, maybe force-restart polling for jobs.
  }
};

/**
 * @param {string=} description debug title.
 * @param {Function} f the function to schedule.
 * @return {webdriver.promise.Promise} the scheduled promise.
 * @private
 */
WebDriverClient.prototype.scheduleNoFault_ = function(description, f) {
  'use strict';
  return process_utils.scheduleNoFault(this.app_, description, f);
};

/**
 * Starts a child process with the wd_server module.
 *
 * @private
 */
WebDriverClient.prototype.startWdServer_ = function() {
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
WebDriverClient.prototype.scheduleProcessDone_ = function(ipcMsg, job) {
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
WebDriverClient.prototype.startJobRun_ = function(job) {
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
WebDriverClient.prototype.decodeUrlAndPacFromScript_ = function(script) {
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
WebDriverClient.prototype.jobTimeout_ = function(job) {
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
WebDriverClient.prototype.scheduleCleanup_ = function() {
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
