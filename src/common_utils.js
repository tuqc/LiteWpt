
var moment = require('moment');
var util = require('util');

exports.task2Html = function(task) {
  var buf = [];
  buf.push('<pre>');
  buf.push('ID:      ' + task.id);
  if (task.submitTimestamp) {
      buf.push('Submit:  ' +
               exports.timestamp2Str(task.submitTimestamp));
  }
  if (task.startTimestamp) {
      buf.push('Start:   ' +
               exports.timestamp2Str(task.startTimestamp));
  }

  if (task.endTimestamp) {
    buf.push(
        util.format(
            'Finished:<a href="/task/result/%s" target=_blank>%s</a>',
            task.id, exports.timestamp2Str(task.endTimestamp)));
  }

  if (task.url) {
    buf.push('URL:     ' + task.url);
  } else {
    buf.push('<strong>Script:</strong>\n<pre>' + task.script + '</pre>');
  }

  buf.push('</pre>');
  return buf.join('\n');
}

exports.timestamp2Str = function(ts) {
  return moment(ts * 1000).format('YYYY-MM-DD HH:mm:ss');
}
