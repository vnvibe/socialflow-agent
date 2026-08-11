#!/usr/bin/env bash
#
# Hermes API VPS Diagnostics Script
# This script runs on the VPS to troubleshoot why Hermes API is offline.

set -u

echo "========================================================="
echo "          HERMES VPS DIAGNOSTICS REPORT                  "
echo "========================================================="
echo "Timestamp: $(date)"
echo "Host: $(hostname -I | awk '{print $1}')"
echo "---------------------------------------------------------"

echo -e "\n[1/7] Checking PM2 Status..."
if command -v pm2 &> /dev/null; then
  pm2 status hermes-api
  pm2 status hermes-bridge
else
  echo "WARNING: pm2 command not found"
fi

echo -e "\n[2/7] Checking Listening Ports (8100)..."
if command -v ss &> /dev/null; then
  ss -tuln | grep -E "8100|3000|3005" || echo "No listener on port 8100 (Hermes API), 3000, or 3005"
elif command -v netstat &> /dev/null; then
  netstat -tuln | grep -E "8100|3000|3005" || echo "No listener on port 8100 (Hermes API), 3000, or 3005"
else
  echo "WARNING: ss/netstat not found"
fi

echo -e "\n[3/7] Checking Docker Containers..."
if command -v docker &> /dev/null; then
  docker ps | grep -E "hermes|contentflow" || echo "No running Hermes Docker containers found"
else
  echo "WARNING: docker not found"
fi

echo -e "\n[4/7] Checking Config Files..."
CONFIG_PATH="/root/.hermes/config.yaml"
ENV_PATH="/root/.hermes/.env"

if [[ -f "$CONFIG_PATH" ]]; then
  echo "✓ config.yaml found at $CONFIG_PATH"
  echo "--- config.yaml (masked) ---"
  cat "$CONFIG_PATH" | sed -E 's/api_key: .+/api_key: "[MASKED]"/g' | sed -E 's/X-Hermes-Secret: .+/X-Hermes-Secret: "[MASKED]"/g'
else
  echo "✗ config.yaml NOT found at $CONFIG_PATH"
fi

if [[ -f "$ENV_PATH" ]]; then
  echo "✓ .env found at $ENV_PATH"
  echo "--- .env (masked) ---"
  cat "$ENV_PATH" | sed -E 's/(_KEY|_SECRET|API_KEY|TOKEN)=.*/\1=[MASKED]/g'
else
  echo "✗ .env NOT found at $ENV_PATH"
fi

echo -e "\n[5/7] Testing DB Connection..."
DB_URL=$(grep -E "^DATABASE_URL=" "$ENV_PATH" 2>/dev/null | cut -d= -f2- || echo "")
if [[ -z "$DB_URL" ]]; then
  DB_URL="postgresql://socialflow:sf_secure_2026_rot_4821a@127.0.0.1:5432/socialflow"
fi

echo "Using Database Connection Check..."
python3 -c "
import sys
try:
    import psycopg2
    print('psycopg2 is installed, attempting connection...')
    url = '$DB_URL'
    conn = psycopg2.connect(url, connect_timeout=3)
    cur = conn.cursor()
    cur.execute('SELECT version();')
    print('DB Connection Success:', cur.fetchone()[0])
    cur.execute('SELECT COUNT(*) FROM hermes_config;')
    print('hermes_config rows:', cur.fetchone()[0])
    conn.close()
except Exception as e:
    print('DB Connection FAILED:', str(e))
" 2>/dev/null || {
  python3 -c "
import sys, urllib.parse
try:
    import asyncpg, asyncio
    print('asyncpg is installed, attempting connection...')
    async def test():
        conn = await asyncpg.connect('$DB_URL', timeout=3)
        val = await conn.fetchval('SELECT version();')
        print('DB Connection Success:', val)
        rows = await conn.fetchval('SELECT COUNT(*) FROM hermes_config;')
        print('hermes_config rows:', rows)
        await conn.close()
    asyncio.run(test())
except Exception as e:
    print('DB Connection FAILED:', str(e))
" 2>/dev/null || echo "Python DB test libraries not fully available or connection failed."
}

echo -e "\n[6/7] Testing Hermes API locally..."
if command -v curl &> /dev/null; then
  echo "Calling GET http://127.0.0.1:8100/health..."
  curl -i -s -m 5 http://127.0.0.1:8100/health || echo "Failed to connect to 127.0.0.1:8100/health"
  echo -e "\nCalling GET http://127.0.0.1:8100/status..."
  curl -i -s -m 5 http://127.0.0.1:8100/status || echo "Failed to connect to 127.0.0.1:8100/status"
else
  echo "WARNING: curl not found"
fi

echo -e "\n[7/7] Fetching PM2 Logs for hermes-api (Last 50 lines)..."
if command -v pm2 &> /dev/null; then
  pm2 logs hermes-api --lines 50 --nostream
else
  echo "PM2 not installed"
fi

echo "========================================================="
echo "                DIAGNOSTICS COMPLETE                     "
echo "========================================================="
