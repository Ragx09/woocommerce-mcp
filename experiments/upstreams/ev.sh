#!/bin/sh
# start|stop the reference upstream on :3001 (pid in /tmp/ev.pid)
case "$1" in
  start) PORT=3001 nohup node "$(dirname "$0")/node_modules/@modelcontextprotocol/server-everything/dist/index.js" streamableHttp >>/tmp/ev.log 2>&1 & echo $! >/tmp/ev.pid ;;
  stop) [ -f /tmp/ev.pid ] && kill "$(cat /tmp/ev.pid)" 2>/dev/null; rm -f /tmp/ev.pid ;;
esac
