#!/usr/bin/env bash

ssh frank@192.168.0.178 '
echo "== users ==" && w
echo "== disk ==" && df -h
echo "== memory ==" && free -h
echo "== failed services ==" && systemctl --failed --no-pager
echo "== top cpu ==" && ps -eo pid,ppid,cmd,%mem,%cpu --sort=-%cpu | head
echo "== recent errors ==" && journalctl -p 3 -xb --no-pager | tail -50
'
