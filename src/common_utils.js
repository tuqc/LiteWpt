
var moment = require('moment');
var util = require('util');

/**
 * Convert task to html.
 *
 * @param {Object} task input task.
 * @return {String} output html string.
 */
exports.task2Html = function(task) {
  var buf = [];
  buf.push('<pre>');
  if (task.success === undefined) {
    buf.push('ID:      ' + task.id);
  } else {
    buf.push('ID:      ' + task.id + '   Status:' +
             (task.success ?
              '<font color="green">Success</font>' :
              '<font color="red">Failed</font>'));
  }
  if (task.tcpdump) {
    buf.push('TCPDump: ' + !!task.tcpdump);
  }
  if (task.proxyPacUrl) buf.push('Proxy Pac:' + task.proxyPacUrl);
  if (task.proxyServer) buf.push('Proxy Server:' + task.proxyServer);
  if (task.submitTimestamp) {
      buf.push('Submit:  ' +
               exports.timestamp2Str(task.submitTimestamp));
  }
  if (task.startTimestamp) {
      buf.push('Start:   ' +
               exports.timestamp2Str(task.startTimestamp));
  }

  if (task.endTimestamp) {
    var detailLinkTpl = '/static/harviewer.html?path=' +
        '/task/result/%s/har.json&expand=true&validate=false';
    var detailLink = util.format(detailLinkTpl, task.id);
    var screenshotLink = util.format('/task/result/%s/screen.png?view=true',
                                     task.id);
    buf.push(
        util.format(
            'Finished:%s <a href="%s" target=_blank>Details</a> ' +
            '<a href="%s" target=_blank>Screenshot</a> ' +
            '<a href="/task/result/%s" target=_blank>Raw output</a>',
            exports.timestamp2Str(task.endTimestamp), detailLink,
            screenshotLink, task.id));
  }

  if (task.url) {
    buf.push('URL:     ' + task.url);
  } else {
    buf.push('<strong>Script:</strong>\n<pre>' + task.script + '</pre>');
  }

  buf.push('</pre>');
  return buf.join('\n');
};

/**
 * Clone object.
 *
 * @param {Object} oldObject input object.
 * @return {Object} cloned object.
 */
exports.cloneObject = function(oldObject) {
  var copy = Object.create( Object.getPrototypeOf(oldObject) );
  var propNames = Object.getOwnPropertyNames(oldObject);

  propNames.forEach(function(name){
    var desc = Object.getOwnPropertyDescriptor(oldObject, name);
    Object.defineProperty(copy, name, desc);
  });
  return copy;
};

/**
 * Parse unix timestamp to readable string.
 *
 * @param {number} ts input timesatmp.
 * @return {String} output string.
 */
exports.timestamp2Str = function(ts) {
  return moment(ts * 1000).format('YYYY-MM-DD HH:mm:ss');
};
