#!/bin/bash

export ROOT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
export OS=`uname -ms`
# Use the latest WebDriver javascript
export NODE="$ROOT_DIR/pkgs/node-v0.10.15-linux-x64/bin/node"
export NODE_PATH="${NODE_PATH}:${ROOT_DIR}/src"


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

$NODE ${ROOT_DIR}/src/agent_main.js ${cmd_arg} ${opt_args}
