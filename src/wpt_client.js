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
var crypto = require('crypto');
var events = require('events');
var fs = require('fs');
var har = require('har');
var http = require('http');
var isrunning = require('is-running')
var logger = require('logger');
var mkdirp = require('mkdirp');
var moment = require('moment');
var multipart = require('multipart');
var path = require('path');
var pcap = require("pcap");
var url = require('url');
var util = require('util');
var Zip = require('node-zip');

/** Allow tests to stub out . */
exports.process = process;

var GET_WORK_SERVLET = 'work/getwork.php';
var RESULT_IMAGE_SERVLET = 'work/resultimage.php';
var WORK_DONE_SERVLET = 'work/workdone.php';

var RESULT_DIR = './result';

// Task JSON field names
var JOB_TEST_ID = 'Test ID';
var JOB_CAPTURE_VIDEO = 'Capture Video';
var JOB_RUNS = 'runs';
var JOB_FIRST_VIEW_ONLY = 'fvonly';

var DEFAULT_JOB_TIMEOUT = 60000;
/** Allow test access. */
exports.NO_JOB_PAUSE = 5000;
var MAX_RUNS = 1000;  // Sanity limit
var MAX_TCP_DUMP_LINE = 100000; // Sanity limit
//Sanity limit. Max tcp dump time to prevent too large dump file
var MAX_TCP_DUMP_TIME = 30 * 1000;


/**
 * A job to run, usually received from the server.
 *
 * Public attributes:
 *   task JSON descriptor received from the server for this job.
 *   id the job id
 *   captureVideo true to capture a video of the page load.
 *   runs the total number of repetitions for the job.
 *   runNumber the current iteration number.
 *       Incremented when calling runFinished with isRunFinished=true.
 *   isFirstViewOnly if true, each run is in a clean browser session.
 *       if false, a run includes two iterations: clean + repeat with cache.
 *   isCacheWarm false for first load of a page, true for repeat load(s).
 *       False by default, to be set by callbacks e.g. Client.onStartJobRun.
 *       Watch out for old values, always set on each run.
 *   resultFiles array of ResultFile objects.
 *   zipResultFiles map of filenames to Buffer objects, to send as result.zip.
 *   error an error object if the job failed.
 *
 * The constructor does some input validation and throws an Error, but it
 * would not report the error back to the WPT server, because Client.currentJob_
 * is not yet set -- the error would only get logged.
 *
 * @this {Job}
 * @param {Object} client should submit this job's results when done.
 * @param {Object} task holds information about the task such as the script
 *                 and browser.
 */
function Job(client, task) {
  'use strict';
  this.client_ = client;
  this.task = task;
  if (!task.id) {
    task.id = Job.generateID();
  }
  this.id = task.id;
  this.captureVideo = (1 === task[JOB_CAPTURE_VIDEO]);
  var runs = task[JOB_RUNS] ? task[JOB_RUNS] : 1;
  if ('number' !== typeof runs || runs <= 0 || runs > MAX_RUNS ||
      0 !== (runs - Math.floor(runs))) {  // Make sure it's an integer.
    throw new Error('Task has invalid/missing number of runs: ' +
        JSON.stringify(task));
  }
  //Only allow run 1 time
  this.runs = 1;
  this.runNumber = 1;
  var firstViewOnly = task[JOB_FIRST_VIEW_ONLY];
  if (undefined !== firstViewOnly &&  // Undefined means false.
      0 !== firstViewOnly && 1 !== firstViewOnly) {
    throw new Error('Task has invalid fvonly field: ' + JSON.stringify(task));
  }
  this.isFirstViewOnly = !!firstViewOnly;
  this.isCacheWarm = !!task.isCacheWarm;
  this.resultFiles = [];
  this.zipResultFiles = {};
  this.error = undefined;

  this.tcpFilterPatterns = [];
}
/** Public class. */
exports.Job = Job;


Job.generateID = function(job) {
  var randStr = crypto.randomBytes(2).toString('hex');
  var dateStr = moment().format('YYYYMMDDHHmm');
  return dateStr + '_' + randStr;
}

Job.prototype.processHAR = function(harJson) {
  'use strict';
  if (harJson && harJson.log.pages.length > 0 &&
      harJson.log.entries.length > 0) {
    this.task['success'] = true;
  } else {
    this.task['success'] = false;
  }
}

/**
 * Start tcp dump raw binary meesgae
 */
Job.prototype.startTCPDumpRaw = function() {
  var jobResult = this.client_.getJobResult(this.id);
  this.tcpdumpRawFile = jobResult.getResultFile('tcpdump.raw');
  jobResult.mkdirp((function(err){
    this.tcpdumpProcess = child_process.spawn(
        'tcpdump', ['-w', this.tcpdumpRawFile]);
    this.tcpdumpPid = this.tcpdumpProcess.pid;
    // Stop the tcpdump when timeout.
    gloabl.setTimeout((function(){
      this.stopTCPDump();
    }).bind(this), MAX_TCP_DUMP_TIME);

  }).bind(this));
}

Job.prototype.stopTCPDumpRaw = function() {
  if (this.tcpdumpProcess) {
    this.tcpdumpProcess.kill('SIGTERM');
    global.setTimeout((functuon(){
      if (!this.tcpdumpPid) {
        return;
      }
      var pid = this.tcpdumpPid;
      // Double check, kill it if process is live.
      isrunning(pid, function(err, live){
        if (live) {
          child_process.spawn('kill', ['-9', '' + pid])
        }
      });
    }).bind(this), 30 * 1000);
    this.tcpdumpProcess = undefined;
  }
}

/**
 * Start tcp dump to text using node_pcap.
 */
Job.prototype.startTCPDumpText = function() {
  this.pcapBuffer = [];
  this.pcapListener = (function (rawPacket) {
    if (this.pcapBuffer.length > MAX_TCP_DUMP_LINE) {
      logger.error('TCPDump max line exceed %s', this.tcpDumpLineNum);
      return;
    }
    var message = undefined;
    try {
      var packet = pcap.decode.packet(rawPacket);
      message = pcap.print.packet(packet);
      var dateStr = moment().format('HH:mm:ss');
      if (this.tcpFilterPatterns) {
        for (var i = 0; i < this.tcpFilterPatterns.length; ++i) {
          var pattern = this.tcpFilterPatterns[i];
          if (message.indexOf(pattern) >= 0) return;
        }
      }
      message = dateStr + ' ' + message;
      if (message) {
        this.pcapBuffer.push(message);
      }
    } catch (err) {
      logger.error('%j', err);
    }
  }).bind(this);
  this.client_.pcapSession.on('packet', this.pcapListener);
}

Job.prototype.stopTCPDumpText = function() {
  if (this.pcapListener) {
    this.client_.pcapSession.removeListener('packet', this.pcapListener);
    this.pcapListener = undefined;
    this.resultFiles.push(
        new ResultFile(ResultFile.ContentType.TEXT,
                      'tcpdump.txt', this.pcapBuffer.join('\n')));
    this.pcapBuffer = [];
  }
}

/**
 * Stop all tcp dump process.
 */
Job.prototype.stopTCPDump = function() {
  this.stopTCPDumpRaw();
  this.stopTCPDumpText();
}

/**
 * Called to finish the current run of this job, submit results, start next run.
 *
 * @param {boolean} isRunFinished true if finished.
 */
Job.prototype.runFinished = function(isRunFinished) {
  'use strict';
  this.stopTCPDump();
  if (isRunFinished && this === this.client_.currentJob_) {
    this.task['endTimestamp'] = moment().unix();
    this.client_.finishedTasks.push(common_utils.cloneObject(this.task));
    if (this.client_.finishedTasks.length > 1000) {
      this.client_.finishedTasks.shift();
    }

    this.resultFiles.push(
        new ResultFile(ResultFile.ContentType.JSON,
                      'task.json', JSON.stringify(this.task)));
    var jobResult = new JobResult(this.id, this.client_.resultDir);

    jobResult.writeResult(this.resultFiles, (function(){
      this.resultFiles = [];
      this.client_.finishRun_(this, isRunFinished);
    }).bind(this));
  } else {
    this.client_.finishRun_(this, isRunFinished);
  }
};

function JobResult(jobID, baseDir) {
  'use strict';
  this.jobID = jobID;
  this.baseDir = baseDir;
  this.path = this.getResultDir();
}
exports.JobResult = JobResult;

JobResult.prototype.getResultDir = function() {
  'use strict';
  var dateStr = this.jobID.split('_')[0];
  var date = moment(dateStr, 'YYYYMMDDHHmm');
  var align = function(num) {
    return num >= 10 ? '' + num : '0' + num;
  }
  var path = util.format('%s/%s/%s/%s/%s/%s', this.baseDir,
                         align(date.year()), align(date.month() + 1),
                         align(date.date()), align(date.hour()),
                         this.jobID);
  return path;
}

/**
 * Make job result directory.
 */
JobResult.prototype.mkdirp = function(callback) {
  mkdirp(this.path, function(err){
    if (!err) {
      callback();
    }
  });
}

JobResult.prototype.getResultFile = function(filename) {
  return this.path + '/' + filename;
}

JobResult.prototype.writeResult = function(resultFiles, callback) {
  'use strict';
  logger.info('Write results %s to %s', this.jobID, this.path);

  var writeFile = (function(resultFile, fn){
    // Write File
    var filePath = this.getResultFile(resultFile.fileName);
    fs.writeFile(filePath, resultFile.content, function(err) {
      fn(err);
      resultFile.content = undefined;
    });
  }).bind(this);


  mkdirp(this.path, (function(err){
    if (err) {
      logger.error(err);
    }
    // Write result files
    async.each(resultFiles, writeFile, function(err){
      if (err) {
        logger.error('Write file error. %s', err);
      }
      if(callback){
        callback();
      }
    });
  }).bind(this));
}

JobResult.prototype.getHAR = function(resultFiles) {
  'use strict';
}

/**
 * ResultFile sets information about the file produced as a
 * result of running a job.
 *
 * @this {ResultFile}
 *
 * @param {string=} resultType a ResultType constant defining the file role.
 * @param {string} fileName file will be sent to the server with this filename.
 * @param {string} contentType MIME content type.
 * @param {string|Buffer} content the content to send.
 */
function ResultFile(contentType, fileName, content, runNumber) {
  'use strict';
  this.fileName = fileName;
  this.contentType = contentType;
  this.content = content;
}
/** Public class. */
exports.ResultFile = ResultFile;

/**
 * Constants to use for ResultFile.contentType.
 */

ResultFile.ContentType = Object.freeze({
  IMAGE: 'image',
  IMAGE_PNG: 'image/png',
  IMAGE_JPEG: 'image/jpeg',
  TEXT: 'text/plain',
  JSON: 'application/json',
  ZIP: 'application/zip',
});


/**
 * processResponse will take a http GET response, concat its data until it
 * finishes and pass it to callback
 *
 * @param {Object} response http GET response object.
 * @param {Function} callback Function({string} responseBody) called on
 *   completed http request body.
 */
exports.processResponse = function(response, callback) {
  'use strict';
  var responseBody = '';
  response.setEncoding('utf8');
  response.on('data', function(chunk) {
    responseBody += chunk;
  });
  response.on('error', function(e) {
    logger.error('Unable to processResponse ' + e.stack);
    if (callback) {
      callback('');
    }
  });
  response.on('end', function() {
    logger.extra('Got response: %s', responseBody);
    if (callback) {
      callback(responseBody);
    }
  });
};

/**
 * A WebPageTest client that talks to the WebPageTest server.
 *
 * @this {Client}
 * #field {Function=} onStartJobRun called upon a new job run start.
 *     #param {Job} job the job whose run has started.
 *         MUST call job.runFinished() when done, even after an error.
 * #field {Function=} onJobTimeout job timeout callback.
 *     #param {Job} job the job that timed out.
 *         MUST call job.runFinished() after handling the timeout.
 *
 * @param {Object} args that contains:
 *     #param {string} serverUrl server base URL.
 *     #param {string} location location name to use for job polling
 *        and result submission.
 *     #param {?string=} deviceSerial mobile device id, if any.
 *     #param {?string=} apiKey API key, if any.
 *     #param {number=} jobTimeout milliseconds until the job is killed.
 */
function Client(args) {
  'use strict';
  events.EventEmitter.call(this);
  var serverUrl = (args.serverUrl || '');
  if (-1 === serverUrl.indexOf('://')) {
    serverUrl = 'http://' + serverUrl;
  }
  this.baseUrl_ = url.parse(serverUrl || '');
  // Bring the URL path into a normalized form ending with /
  // The trailing / is for url.resolve not to strip the last path component
  var urlPath = this.baseUrl_.path;
  if (urlPath && urlPath.slice(urlPath.length - 1) !== '/') {
    urlPath += '/';
  }
  if (!urlPath) {
   // throw new Error('Invalid serverUrl: ' + args.serverUrl);
  }
  this.baseUrl_.path = urlPath;
  this.baseUrl_.pathname = urlPath;
  this.location_ = args.location;
  this.deviceSerial_ = args.deviceSerial;
  this.apiKey = args.apiKey;
  this.timeoutTimer_ = undefined;
  this.currentJob_ = undefined;
  this.jobTimeout = args.jobTimeout || DEFAULT_JOB_TIMEOUT;
  this.onGetTesterInfo = undefined;
  this.onStartJobRun = undefined;
  this.onJobTimeout = undefined;
  this.handlingUncaughtException_ = undefined;
  this.resultDir = args.resultDir || RESULT_DIR;
  this.jobQueue = new Array();

  this.finishedTasks = new Array();
  logger.info('Write result data to %s', this.resultDir);

  exports.process.on('uncaughtException', this.onUncaughtException_.bind(this));
  
  this.pcapSession = pcap.createSession();

  logger.extra('Created Client (urlPath=%s): %j', urlPath, this);
}
util.inherits(Client, events.EventEmitter);
/** Allow test access. */
exports.Client = Client;

/**
 * Unhandled exception in the client process.
 *
 * @param {Error} e error object.
 * @private
 */
Client.prototype.onUncaughtException_ = function(e) {
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

Client.prototype.getJobResult = function(jobID) {
  return new JobResult(jobID, this.resultDir);
}

Client.prototype.addTask = function(task) {
  var job = new Job(this, task);
  logger.info('Add task: %j', task);
  this.jobQueue.push(job);
  return job.id;
}

Client.prototype.runNextJob = function() {
  var job = this.jobQueue.shift();
  if (job) {
    logger.info('Run job: %s', job.id);
    job.task['startTimestamp'] = moment().unix();
    this.startNextRun_(job);
  } else {
    this.emit('nojob');
  }
}

/**
 * processJobResponse_ processes a server response and starts a new job
 *
 * @private
 *
 * @param {string} responseBody server response as stringified JSON
 *                 with job information.
 */
Client.prototype.processJobResponse_ = function(responseBody) {
  'use strict';
  // Catch parse exceptions here, since our onUncaughtException_ handler lacks
  // a currentJob_.  We can't report this error back to the WPT server, since
  // we're unable to parse the Task ID, so we'll simply ignore it.
  var task;
  try {
    task = JSON.parse(responseBody);
  } catch (e) {
    logger.warn('Ignoring job with invalid JSON: "%s"', responseBody);
    this.emit('nojob');
    return;
  }
  var job = new Job(this, task);
  logger.info('Got job: %j', job.id);
  this.startNextRun_(job);
};

/**
 * @param {Job} job the job to start/continue.
 * @private
 */
Client.prototype.startNextRun_ = function(job) {
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
Client.prototype.finishRun_ = function(job, isRunFinished) {
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

function createZip(zipFileMap, fileNamePrefix) {
  'use strict';
  var zip = new Zip();
  Object.getOwnPropertyNames(zipFileMap).forEach(function(fileName) {
    var content = zipFileMap[fileName];


    var body = content;
    var bodyBuffer = (body instanceof Buffer ? body : new Buffer(body));
     fs.mkdir('results/', parseInt('0755', 8), function(e) {
        if (!e || 'EEXIST' === e.code) {
          var subdir = 'results/tmp/';
          fs.mkdir(subdir, parseInt('0755', 8), function(e) {
            if (!e || 'EEXIST' === e.code) {
              fs.writeFile(subdir + fileName, bodyBuffer);
            }
          });
        }
      });

    logger.debug('Adding %s%s (%d bytes) to results zip',
        fileNamePrefix, fileName, content.length);
    zip.file(fileNamePrefix + fileName, content);
  });
  // Convert back and forth between base64, otherwise corrupts on long content.
  // Unfortunately node-zip does not support passing/returning Buffer.
  return new Buffer(
      zip.generate({compression: 'DEFLATE', base64: true}), 'base64');
}

/**
 * Submits one part of the job result, with an optional file.
 *
 * @private
 *
 * @param {Object} job the result file will be saved for.
 * @param {Object} resultFile of type ResultFile. May be null/undefined.
 * @param {Array=} fields an array of [name, value] text fields to add.
 * @param {Function=} callback will get called with the HTTP response body.
 */
Client.prototype.postResultFile_ = function(job, resultFile, fields, callback) {
  'use strict';
  logger.extra('postResultFile: job=%s resultFile=%s fields=%j callback=%s',
      job.id, (resultFile ? 'present' : null), fields, callback);
  var servlet = WORK_DONE_SERVLET;
  var mp = new multipart.Multipart();
  mp.addPart('id', job.id, ['Content-Type: text/plain']);
  mp.addPart('location', this.location_);
  if (this.apiKey) {
    mp.addPart('key', this.apiKey);
  }
  if (fields) {
    fields.forEach(function(nameValue) {
      mp.addPart(nameValue[0], nameValue[1]);
    });
  }
  if (resultFile) {
    // A part with name="resultType" and then the content with name="file"
    if (exports.ResultFile.ContentType.IMAGE_PNG === resultFile.contentType) {
      // Images go to a different servlet and don't need the resultType part
      servlet = RESULT_IMAGE_SERVLET;
    } else {
      if (resultFile.contentType) {
        mp.addPart(resultFile.contentType, '1');
      }
      mp.addPart('_runNumber', String(job.runNumber));
      mp.addPart('_cacheWarmed', job.isCacheWarm ? '1' : '0');
    }
    var fileName = job.runNumber + (job.isCacheWarm ? '_Cached_' : '_') +
        resultFile.fileName;
    mp.addFilePart(
        'file', fileName, resultFile.contentType, resultFile.content);
    if (logger.isLogging('debug')) {
      logger.debug('Writing a local copy of %s', fileName);
      var body = resultFile.content;
      var bodyBuffer = (body instanceof Buffer ? body : new Buffer(body));
      fs.mkdir('results/', parseInt('0755', 8), function(e) {
        if (!e || 'EEXIST' === e.code) {
          var subdir = 'results/' + job.id + '/';
          fs.mkdir(subdir, parseInt('0755', 8), function(e) {
            if (!e || 'EEXIST' === e.code) {
              fs.writeFile(subdir + fileName, bodyBuffer);
            }
          });
        }
      });
    }
  }
  // TODO(klm): change body to chunked request.write().
  // Only makes sense if done for file content, the rest is peanuts.
  var mpResponse = mp.getHeadersAndBody();

  var options = {
      method: 'POST',
      host: this.baseUrl_.hostname,
      port: this.baseUrl_.port,
      path: '/hello',
      //path: path.join(this.baseUrl_.path, servlet),
      headers: mpResponse.headers
    };
  var request = http.request(options, function(res) {
    exports.processResponse(res, callback);
  });
  request.on('error', function(e) {
    logger.warn('Unable to post result: ' + e.message);
  });
  request.end(mpResponse.bodyBuffer, 'UTF-8');
};

/**
 * submitResult_ posts all result files for the job and emits done.
 *
 * @param {Object} job that should be completed.
 * @param {boolean} isRunFinished true if finished.
 * @param {Function} callback Function({Error?} err).
 * @private
 */
Client.prototype.submitResult_ = function(job, isRunFinished, callback) {
  'use strict';
  logger.debug('submitResult_: job=%s', job.id);
  var filesToSubmit = job.resultFiles.slice();
  // If there are job.zipResultFiles, add results.zip to job.resultFiles.
  if (Object.getOwnPropertyNames(job.zipResultFiles).length > 0) {
    var zipResultFiles = job.zipResultFiles;
    job.zipResultFiles = {};
    var fileNamePrefix = job.runNumber + (job.isCacheWarm ? '_Cached_' : '_');
    filesToSubmit.push(new ResultFile(
        /*resultType=*/undefined,
        'results.zip',
        'application/zip',
        createZip(zipResultFiles, fileNamePrefix)));
  }
  job.resultFiles = [];
  // Chain submitNextResult calls off of the HTTP request callback
  var submitNextResult = (function() {
    var resultFile = filesToSubmit.shift();
    var fields = [];
    if (resultFile) {
      if (job.error) {
        fields.push(['error', job.error]);
      }
      this.postResultFile_(job, resultFile, fields, submitNextResult);
    } else {
      if (job.runNumber === job.runs && isRunFinished) {
        fields.push(['done', '1']);
        if (job.error) {
          fields.push(['testerror', job.error]);
        }
        this.postResultFile_(job, undefined, fields, function() {
          if (callback) {
            callback();
          }
          this.emit('done', job);
        }.bind(this));
      } else if (callback) {
        callback();
      }
    }
  }.bind(this));
  submitNextResult();
};

/**
 * Requests a job from the server and notifies listeners about the outcome.
 *
 * Event 'job' has the Job object as an argument. Calling done() on the job
 * object causes the client to submit the job result and emit 'done'.
 *
 * If the job done() does not get called within a fixed timeout, emits
 * 'timeout' with the job as an argument - to let other infrastructure clean up,
 * and then submits the job result and emits 'done'.
 *
 * @param {boolean} forever if false, make only one request. If true, chain
 *                  the request off of 'done' and 'nojob' events, running
 *                  forever or until the server responds with 'shutdown'.
 */
Client.prototype.run = function() {
  'use strict';
  var self = this;
  this.on('nojob', function() {
    logger.info('No more job, pause ' + exports.NO_JOB_PAUSE);
    global.setTimeout(function() {
      self.runNextJob();
    }, exports.NO_JOB_PAUSE);
  });

  this.on('done', function() {
    self.runNextJob();
  });

  this.runNextJob();
};
