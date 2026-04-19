#!/bin/bash
echo "$(date): launched" >> /tmp/navie_host.log
exec "/usr/bin/python3" "/Users/usuario/Desktop/Navienalisis Updates/native-host/navie_updater.py" >> /tmp/navie_host.log 2>&1
