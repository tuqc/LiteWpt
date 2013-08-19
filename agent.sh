#!/bin/bash

export DISPLAY=:99
export ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
export OS=`uname -ms`
# Use the latest WebDriver javascript
export NODE="$ROOT_DIR/pkgs/node-v0.10.15-linux-x64/bin/node"
export NODE_PATH="${NODE_PATH}:${ROOT_DIR}/src"

CMD=$1;
shift 1;

std_file="$ROOT_DIR/std.out"
lock_file="$ROOT_DIR/tbnb.pid"
cat /dev/null >> $lock_file

stop() {
  read last_pid < $lock_file
  if [ "$last_pid" != "" ] && kill -0 &>1 >/dev/null $last_pid
  then
    echo "Stop agent pid=$last_pid ..."
    kill $last_pid
  else
    echo 'Not running'
  fi
}


force_stop() {
  killall node
}

status() {
  read last_pid < $lock_file
  if [ "$last_pid" != "" ] && kill -0 &>1 >/dev/null $last_pid
  then
    echo "Running"
  else
    echo "Not running"
  fi
}

start() {
  read last_pid < $lock_file
  if [ "$last_pid" != "" ] && kill -0 &>1 >/dev/null $last_pid
  then
    echo 'Already running'
    exit
  fi

  declare browser="browser_local_chrome.BrowserLocalChrome"
  # Parse args
  while [[ $# -gt 0 ]]; do
    OPTION=$1; shift 1
    case "$OPTION" in
    -b | --browser | -c)
       browser="$1"; shift 1;;
    -q | --quiet)
       export WPT_VERBOSE=false;;
    -m | --max_log)
      export WPT_MAX_LOGLEVEL="$1"; shift 1;;
    -h | --help)
      usage;;
    --*)
      opt_args=("${opt_args[@]:+${opt_args[@]}}" "$OPTION" "$1"); shift 1;;
    *) echo "Unknown option: $OPTION"; exit 1;;
    esac
  done

  declare -a selenium_jars=("${ROOT_DIR}/lib/selenium-standalone-"*.jar)
  declare selenium_jar="${selenium_jars[@]:+${selenium_jars[${#selenium_jars[@]}-1]}}"
  declare -a chromedrivers=("${ROOT_DIR}/lib/chromedriver-"*)
  declare chromedriver="${chromedrivers[@]:+${chromedrivers[${#chromedrivers[@]}-1]}}"
  export cmd_arg="--browser ${browser} --chromedriver ${chromedriver} --seleniumJar ${selenium_jar}"

  if ! ps -ef |grep -v grep |grep Xvfb |grep $DISPLAY &>1 >/dev/null
  then
    start_xvfb
  fi

  echo 'Start agent...'
  $NODE ${ROOT_DIR}/src/agent_main.js ${cmd_arg} ${opt_args} </dev/null >$std_file 2>&1 &
  echo $! > $lock_file
}

start_xvfb() {
  if ps -ef |grep -v grep |grep Xvfb |grep $DISPLAY &>1 >/dev/null
  then
    echo 'Xvfb already running.'
  else
    echo 'Start Xvfb...'
    Xvfb :99 -screen 0 1024x768x24 </dev/null >/dev/null  2>&1 &
  fi
}

stop_xvfb() {
  if ps -ef |grep -v grep |grep Xvfb |grep $DISPLAY &>1 >/dev/null
  then
    killall Xvfb
  fi
}

case "$CMD" in
        start)
            start
            status
            ;;         
        stop)
            stop
            ;;
        kill)
            force_stop
            sleep 2
            status
            ;;         
        status)
            status
            ;;
        restart)
            stop
            start
            ;;                 
        start_xvfb)
          start_xvfb
          ;;             
        stop_xvfb)
          stop_xvfb
          ;;
        *)
          echo $"Usage: $0 {start|stop|restart|kill|status}"
          exit 1
esac
