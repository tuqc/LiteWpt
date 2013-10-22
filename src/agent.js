
var events = require('events');
var fs = require('fs');
var isrunning = require('isrunning');
var logger = require('logger');
var util = require('util');

// Sanity limit. Max tcp dump time to prevent too large dump file
var MAX_TCP_DUMP_TIME = 30 * 1000;
// Max days job data will be kept on disk.
var MAX_JOB_KEEP_DAYS = 5; // 5 days
// Default directory of result file.
var DEFAULT_BASE_RESULT_DIR = './result/';

/** Abstract test client. */
export Agent = Agent;
/** Public job class. */
export Task = Task;

function Agent() {
  'use strict';
  events.EventEmitter.call(this);
  this.taskQueue = [];
  this.runningCount = 0;
}
util.inherits(Agent, events.EventEmitter);

Agent.prototype.run = function() {
  'use strict';
  throw new Error('Operation not implement.');

  this.on('next', function() {
    this.runNext();
  }.bind(this));
}

/**
 * Add task for test.
 * @param {Object} task
 */
Agent.prototype.addTask = function(taskDef) {
  'use strict';
  this.taskQueue.push(taskDef);
};

Agent.prototype.getBaseResultDir = function() {
  return DEFAULT_BASE_RESULT_DIR;
};

Agent.prototype.runNext = function() {

};

Agent.prototype.finishTask(task) {
  this.runningCount -= 1;
  logger.debug('PhantomJS finish task ' + task.url);

  if (this.runningCount < MAX_PHANTOMJS_PROCESS) {
    this.runNext();
  }
}

/**
 * Start tcp dump raw binary meesgae
 */
Agent.prototype.startTCPDump = function(dumpFilePath) {
  //var jobResult = this.client_.getTaskResult(this.id);
 // this.tcpdumpRawFile = jobResult.getResultFile('tcpdump.raw');
  this.dumpFilePath = dumpFilePath;
  jobResult.mkdirp((function(err) {
    this.tcpdumpProcess = child_process.spawn(
        'tcpdump', ['-w', this.dumpFilePath]);
    this.tcpdumpPid = this.tcpdumpProcess.pid;
    // Stop the tcpdump when timeout.
    global.setTimeout((function() {
      this.stopTCPDump();
    }).bind(this), MAX_TCP_DUMP_TIME);
  }).bind(this));
};

/**
 * Stop tcpdump process.
 */
Agent.prototype.stopTCPDump = function() {
  if (this.tcpdumpProcess) {
    this.tcpdumpProcess.kill('SIGTERM');
    global.setTimeout((function() {
      if (!this.tcpdumpPid) {
        return;
      }
      var pid = this.tcpdumpPid;
      // Double check, kill it if process is live.
      isrunning(pid, function(err, live) {
        if (live) {
          child_process.spawn('kill', ['-9', '' + pid])
        }
      });
    }).bind(this), 30 * 1000);
    this.tcpdumpProcess = undefined;
  }
};

/**
 * Called to finish the current run of this job, write results, start next run.
 *
 * @param {boolean} isRunFinished true if finished.
 */
Agent.prototype.runFinished = function(isRunFinished) {
  'use strict';
  if (this.tcpdump) this.stopTCPDump();
  if (isRunFinished && this === this.client_.currentTask_) {
    this.taskDef.endTimestamp = moment().unix();
    this.client_.finishedTasks.push(common_utils.cloneObject(this.taskDef));
    if (this.client_.finishedTasks.length > 1000) {
      this.client_.finishedTasks.shift();
    }

    this.resultFiles.push(
        new ResultFile(ResultFile.ContentType.JSON,
                      'task.json', JSON.stringify(this.taskDef)));
    var jobResult = new TaskResult(this.id, this.client_.resultDir);

    jobResult.writeResult(this.resultFiles, (function() {
      this.resultFiles = [];
      this.client_.finishRun_(this, isRunFinished);
    }).bind(this));
  } else {
    this.client_.finishRun_(this, isRunFinished);
  }
};

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
 *       False by default, to be set by callbacks e.g. Client.onStartTaskRun.
 *       Watch out for old values, always set on each run.
 *   resultFiles array of ResultFile objects.
 *   zipResultFiles map of filenames to Buffer objects, to send as result.zip.
 *   error an error object if the job failed.
 *
 * The constructor does some input validation and throws an Error, but it
 * would not report the error back to the WPT server, because Client.currentTask_
 * is not yet set -- the error would only get logged.
 *
 * @this {Task}
 * @param {Object} client should submit this job's results when done.
 * @param {Object} task holds information about the task such as the script
 *                 and browser.
 */
function Task(agent, taskDef) {
  'use strict';
  this.agent = agent;
  this.taskDef = taskDef;
  if (!taskDef.id) {
    taskDef.id = Task.generateID();
  }
  this.id = taskDef.id;
  this.error = undefined;
}
/** Public class. */
exports.Task = Task;

/**
 * Generate unique job id in specific format.
 * The can find the job result directory according the id.
 *
 * @param {Object} job input job.
 * @return {String} unique job id.
 */
Task.generateID = function(job) {
  var randStr = crypto.randomBytes(2).toString('hex');
  var dateStr = moment().format('YYYYMMDDHHmm');
  return dateStr + '_' + randStr;
};

/**
 * Deduce test reuslt directory from task id.
 * @param  {String} idStr
 * @return {String}
 */
Task.deduceReusltDir = function(idStr) {
  var dateStr = idStr.split('_')[0];
  var date = moment(dateStr, 'YYYYMMDDHHmm');
  var align = function(num) {
    return num >= 10 ? '' + num : '0' + num;
  };
  var path = util.format('%s/%s/%s/%s/%s/%s', this.baseDir,
                         align(date.year()), align(date.month() + 1),
                         align(date.date()), align(date.hour()),
                         this.id);
  return path;
}

/**
 * Get task result directory.
 * @return {String}
 */
Task.prototype.getResultDir = function() {
  'use strict';
  return Task.deduceReusltDir(this.id);
}

/**
 * Process HAR object after parsed.
 *
 * @param {Object} harJson parsed HAR.
 */
Task.prototype.processHAR = function(harJson) {
  'use strict';
  if (harJson && harJson.log.pages.length > 0 &&
      harJson.log.entries.length > 0) {
    this.taskDef.success = true;
  } else {
    this.taskDef.success = false;
  }
};



Task.ResultFileName = Object.freeze({
  TASKDEF: 'task.json',
  TCPDUMP: 'tcpdump.raw',
});
