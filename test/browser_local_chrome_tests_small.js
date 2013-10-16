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

var browser_local_chrome = require('browser_local_chrome');
var process_utils = require('process_utils');
var should = require('should');
var sinon = require('sinon');
var test_utils = require('./test_utils.js');
var webdriver = require('webdriver');


/**
 * All tests are synchronous, do NOT use Mocha's function(done) async form.
 *
 * The synchronization is via:
 * 1) sinon's fake timers -- timer callbacks triggered explicitly via tick().
 * 2) stubbing out anything else with async callbacks, e.g. process or network.
 */
describe('browser_local_chrome small', function() {
  'use strict';

  var app = webdriver.promise.Application.getInstance();
  process_utils.injectWdAppLogging('WD app', app);

  var sandbox;
  var processSpawnStub;
  var chromedriver = '/gaga/chromedriver';

  beforeEach(function() {
    sandbox = sinon.sandbox.create();
    test_utils.fakeTimers(sandbox);
    processSpawnStub = test_utils.stubOutProcessSpawn(sandbox);
    processSpawnStub.callback = function() {
      return true; // keep running
    };
  });

  afterEach(function() {
    should.equal('[]', app.getSchedule());
    test_utils.unfakeTimers(sandbox);
    sandbox.verifyAndRestore();
  });

  it('should start and get killed', function() {
    var browser = new browser_local_chrome.BrowserLocalChrome(
        app, {chromedriver: chromedriver});
    should.ok(!browser.isRunning());
    browser.startWdServer({browserName: 'chrome'});
    sandbox.clock.tick(webdriver.promise.Application.EVENT_LOOP_FREQUENCY * 4);
    should.equal('[]', app.getSchedule());
    should.ok(browser.isRunning());
    should.ok(processSpawnStub.calledOnce);
    processSpawnStub.assertCall(chromedriver, '-port=' + browser.serverPort_);
    processSpawnStub.assertCall();

    browser.kill();
    sandbox.clock.tick(webdriver.promise.Application.EVENT_LOOP_FREQUENCY * 4);
    should.equal('[]', app.getSchedule());
    should.ok(!browser.isRunning());
    processSpawnStub.assertCall();
    should.equal(undefined, browser.getServerUrl());
    should.equal(undefined, browser.getDevToolsUrl());
    should.ok(processSpawnStub.firstCall.returnValue.kill.calledOnce);
  });

  it('should start and handle process self-exit', function() {
    var browser = new browser_local_chrome.BrowserLocalChrome(
        app, {chromedriver: chromedriver});
    should.ok(!browser.isRunning());
    browser.startWdServer({browserName: 'chrome'});
    sandbox.clock.tick(webdriver.promise.Application.EVENT_LOOP_FREQUENCY * 4);
    should.equal('[]', app.getSchedule());
    should.ok(browser.isRunning());
    should.equal('http://localhost:' + browser.serverPort_,
                 browser.getServerUrl());
    should.equal('http://localhost:' + browser.devToolsPort_ + '/json',
                 browser.getDevToolsUrl());
    should.ok(processSpawnStub.calledOnce);
    processSpawnStub.assertCall(chromedriver, '-port=' + browser.serverPort_);
    processSpawnStub.assertCall();
    var chromedriverProc = processSpawnStub.firstCall.returnValue;

    chromedriverProc.emit('exit', /*code=*/0);
    sandbox.clock.tick(webdriver.promise.Application.EVENT_LOOP_FREQUENCY * 4);
    should.equal('[]', app.getSchedule());
    should.ok(!browser.isRunning());
    processSpawnStub.assertCall();
    should.equal(undefined, browser.getServerUrl());
    should.equal(undefined, browser.getDevToolsUrl());
    should.ok(chromedriverProc.kill.notCalled);
  });
});
