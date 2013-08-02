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

var browser_ios = require('browser_ios');
var fs = require('fs');
var http = require('http');
var net = require('net');
var process_utils = require('process_utils');
var should = require('should');
var sinon = require('sinon');
var test_utils = require('./test_utils.js');
var video_hdmi = require('video_hdmi');
var webdriver = require('webdriver');

/**
 * All tests are synchronous, do NOT use Mocha's function(done) async form.
 *
 * The synchronization is via:
 * 1) sinon's fake timers -- timer callbacks triggered explicitly via tick().
 * 2) stubbing out anything else with async callbacks, e.g. process or network.
 */
describe('browser_ios small', function() {
  'use strict';

  var app = webdriver.promise.Application.getInstance();
  process_utils.injectWdAppLogging('WD app', app);

  var sandbox;
  var spawnStub;
  var videoStart;
  var videoStop;

  beforeEach(function() {
    sandbox = sinon.sandbox.create();

    test_utils.fakeTimers(sandbox);
    app.reset();  // We reuse the app across tests, clean it up.

    spawnStub = test_utils.stubOutProcessSpawn(sandbox);
    spawnStub.callback = spawnCallback_;
    videoStart = sandbox.stub(
        video_hdmi.VideoHdmi.prototype, 'scheduleStartVideoRecording');
    videoStop = sandbox.stub(
        video_hdmi.VideoHdmi.prototype, 'scheduleStopVideoRecording');
    [http, net].forEach(function(mod) {
      test_utils.stubCreateServer(sandbox, mod);
    });
    sandbox.stub(fs, 'exists', function(path, cb) { if (cb) { cb(false); } });
    sandbox.stub(fs, 'readFile', function(path, cb) {
      if (cb) {
        cb(new Error('no plist'));
      }
    });
    sandbox.stub(fs, 'unlink', function(path, cb) { if (cb) { cb(); } });
    reset_();
  });

  afterEach(function() {
    // Call unfakeTimers before verifyAndRestore, which may throw.
    should.equal('[]', app.getSchedule());
    test_utils.unfakeTimers(sandbox);
    sandbox.verifyAndRestore();
  });

  it('should start and get killed with default environment', function() {
    startBrowser_({runNumber: 1, deviceSerial: 'GAGA123'});
    killBrowser_();
  });

  it('should start and get killed with full environment', function() {
    startBrowser_({runNumber: 1, deviceSerial: 'GAGA123',
         iosDeviceDir: '/gaga/ios/darwin',
         iosSshProxyDir: '/python/proxy',
         iosSshCert: '/home/user/.ssh/my_cert',
         iosUrlOpenerApp: '/apps/urlOpener.ipa'});
    killBrowser_();
  });

  it('should use PAC server', function() {
    startBrowser_({runNumber: 1, deviceSerial: 'GAGA123',
        pac: 'function FindProxyForURL...'});
    killBrowser_();
  });

  it('should record video with the correct device type', function() {
    startBrowser_({runNumber: 1, deviceSerial: 'GAGA123', videoCard: 2});
    startVideo_();
    stopVideo_();
    killBrowser_();
  });

  //
  // IosBrowser wrapper:
  //

  var args;
  var browser;
  var proxyFakeProcess;

  function reset_() {
    args = undefined;
    browser = undefined;
    proxyFakeProcess = undefined;
  }

  function spawnCallback_(proc, cmd, argv) {
    var stdout;
    if ('ssh' === cmd) {
      if (/^echo\s+list\s+Setup.*scutil$/.test(argv[argv.length - 1])) {
        stdout = 'subKey [123] = foo';
      } else {
        stdout = '';
      }
    } else if ('scp' === cmd) {
      stdout = '';
    } else if (/idevice[-_a-z2]+$/.test(cmd)) {
      if (/ideviceinstaller$/.test(cmd)) {
        stdout = 'Install - Complete';
      } else if (/idevice-app-runner$/.test(cmd)) {
        if (-1 !== argv.indexOf('check_gdb')) {
          global.setTimeout(function() {
            proc.stderr.emit('data', 'Unknown APPID (check_gdb) is not in:\n');
          }, 1);
          global.setTimeout(function() {
            ['exit', 'close'].forEach(function(evt) {
              proc.emit(evt, 1);
            });
          }, 5);
          return true; // disable exit(0)
        } else if (-1 !== argv.indexOf('com.google.openURL')) {
          stdout = '';
        }
      } else if (/ideviceinfo$/.test(cmd) &&
          (-1 !== argv.indexOf('ProductType'))) {
        stdout = 'iPhone666';
      }
    } else if (/ios_webkit_debug_proxy$/.test(cmd)) {
      return true; // keep alive
    }
    if (undefined === stdout) {
      should.fail('Unexpected ' + cmd + ' ' + (argv || []).join(' '));
    }
    if (stdout) {
      global.setTimeout(function() {
        proc.stdout.emit('data', stdout);
      }, 1);
    }
    return false; // exit with success
  }

  function startBrowser_(argv) {
    should.equal(undefined, args);
    args = argv;

    should.equal(undefined, browser);
    browser = new browser_ios.BrowserIos(app, args);
    should.equal('[]', app.getSchedule());
    should.ok(!browser.isRunning());

    browser.startBrowser();
    sandbox.clock.tick(webdriver.promise.Application.EVENT_LOOP_FREQUENCY * 30);
    should.equal('[]', app.getSchedule());
    should.ok(browser.isRunning());

    var serial = args.deviceSerial;
    spawnStub.assertCall(/idevice-app-runner$/, '-U', serial, '-r',
        'check_gdb');

    if (1 === args.runNumber) {
      var appPath = (args.iosUrlOpenerApp || 'urlOpener.ipa');
      spawnStub.assertCall(/ideviceinstaller$/, '-U', serial, '-i', appPath);
    }

    var proxy = ['-F', '/dev/null', '-i', /^\//, '-o',
        (/^ProxyCommand="[^"]+"\s+-u\s+%h$/), '-o', 'User=root'];
    var sshMatch = [(/ssh$/)].concat(proxy).concat([serial]);
    spawnStub.assertCalls(
        sshMatch.concat(['killall', 'MobileSafari']),
        sshMatch.concat(['rm', '-rf',
            /\/Cache\.db$/, /\/SuspendState\.plist$/, /\/LocalStorage$/,
            /\/ApplicationCache\.db$/, /\/Cookies\.binarycookies/]));
    if (args.pac) {
      spawnStub.assertCalls(
          sshMatch.concat(['-R', /^\d+:127.0.0.1:\d+$/, '-N']));
    }

    var localPref = /^[^@:\s]+\.plist$/;
    var remotePref = new RegExp('^' + serial + ':[^@:\\s]+\\.plist$');
    spawnStub.assertCalls(
        sshMatch.concat([(/^echo\s+list\s+Setup[^\|]+|\s*scutil$/)]),
        sshMatch.concat([new RegExp(
            '^echo\\s+-e\\s+.*' +
            (args.pac ?
              'd.add\\s+Proxy\\S+\\s+\\S+\/proxy.pac' :
              'd.remove\\s+Proxy') +
            '.*|\\s*scutil$')]),
        [(/scp$/)].concat(proxy).concat([remotePref, localPref]),
        [(/scp$/)].concat(proxy).concat([localPref, remotePref]));

    spawnStub.assertCall(/idevice-app-runner$/, '-u', serial, '-r',
        'com.google.openURL', '--args', /^http:/);

    var devToolsPattern = /^http:\/\/localhost:(\d+)\/json$/;
    browser.getDevToolsUrl().should.match(devToolsPattern);
    var devToolsPort = browser.getDevToolsUrl().match(devToolsPattern)[1];

    spawnStub.assertCall(/ios_webkit_debug_proxy$/, '-c',
        new RegExp('^' + serial + ':' + devToolsPort + '$'));
    spawnStub.assertCall();

    proxyFakeProcess = spawnStub.lastCall.returnValue;
    should.ok(proxyFakeProcess.kill.notCalled);
  }

  function startVideo_() {
    browser.scheduleStartVideoRecording('test.avi');
    sandbox.clock.tick(webdriver.promise.Application.EVENT_LOOP_FREQUENCY * 4);
    should.equal('[]', app.getSchedule());
    should.ok(videoStart.calledOnce);
    spawnStub.assertCall(/ideviceinfo$/, '-k', 'ProductType', '-u',
        args.deviceSerial);
    spawnStub.assertCall();
    test_utils.assertStringsMatch(
        ['test.avi', args.deviceSerial, 'iPhone666', args.videoCard],
        videoStart.firstCall.args.slice(0, 4));
    should.ok(videoStop.notCalled);
  }

  function stopVideo_() {
    browser.scheduleStopVideoRecording();
    sandbox.clock.tick(webdriver.promise.Application.EVENT_LOOP_FREQUENCY * 4);
    spawnStub.assertCall();
    should.equal('[]', app.getSchedule());
    should.ok(videoStart.calledOnce);
    should.ok(videoStop.calledOnce);
  }

  function killBrowser_() {
    should.exist(browser);
    browser.kill();
    sandbox.clock.tick(webdriver.promise.Application.EVENT_LOOP_FREQUENCY * 10);
    should.equal('[]', app.getSchedule());
    should.ok(!browser.isRunning());

    should.equal(undefined, browser.getServerUrl());
    should.equal(undefined, browser.getDevToolsUrl());
    if (args.pac) {
      spawnStub.assertCalls(
         {0: 'ssh', '-1': /^echo\s+list\+Setup.*|\s*scutil$/},
         {0: 'ssh', '-1': /^echo\s+-e\+.*d.remove\s+Proxy.*|\s*scutil$/},
         {0: 'scp', '-1': /^[^:]*\.plist/},
         {0: 'scp', '-1': /:\/.*\.plist/});
    }
    spawnStub.assertCall();
    should.ok(proxyFakeProcess.kill.calledOnce);
    proxyFakeProcess = undefined;
  }
});
