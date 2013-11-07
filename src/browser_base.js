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

var logger = require('logger');
var process_utils = require('process_utils');

/**
 * Base class for browsers.
 *
 * @param {webdriver.promise.ControlFlow} app the ControlFlow for scheduling.
 * @constructor
 */
function BrowserBase(app) {
  'use strict';
  this.app_ = app;
  this.childProcess_ = undefined;
}
/** @constructor */
exports.BrowserBase = BrowserBase;

/**
 * @param {string} command process name.
 * @param {Array} args process args.
 * @param {string} name description for debugging.
 * @return {webdriver.promise.Promise} resolves when process start is complete.
 * @protected
 */
BrowserBase.prototype.startChildProcess = function(command, args, name) {
  'use strict';
  if (this.childProcess_) {
    throw new Error('Internal error: browser child process already running');
  }
  return process_utils.scheduleSpawn(this.app_, command, args,
      undefined,  // Use default spawn options.
      logger.info,  // Log stdout as info.
      logger.warn).then(function(proc) {  // Log stderr as warning.
    this.childProcess_ = proc;
    proc.on('exit', function(code, signal) {
      logger.info(name + ' EXIT code %s signal %s', code, signal);
      this.childProcess_ = undefined;
      this.onChildProcessExit();
    }.bind(this));
  }.bind(this));
};

/**
 * Stub handler for child process exit.
 * Children should override if they want to do something on child process exit.
 * @protected
 */
BrowserBase.prototype.onChildProcessExit = function() { 'use strict'; };

/**
 * @return {boolean}
 */
BrowserBase.prototype.isRunning = function() {
  'use strict';
  return undefined !== this.childProcess_;
};

/**
 * Kills the child process.
 * @protected
 */
BrowserBase.prototype.killChildProcessIfNeeded = function() {
  'use strict';
  if (this.childProcess_) {
    var childProcess = this.childProcess_;
    this.childProcess_ = undefined;
    process_utils.scheduleKillTree(this.app_, 'browser/driver', childProcess);
  } else {
    logger.debug('Browser/driver process already unset, not killing');
  }
};
