#!/bin/bash
cd /Users/Allan/Supplier-Portal
set -a
source .env
set +a
/usr/local/bin/node api/cron/asset-followup.js
