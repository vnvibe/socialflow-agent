#!/bin/bash
echo ""
echo "╔══════════════════════════════════════╗"
echo "║    SocialFlow Agent - Cai dat        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[LOI] Chua cai Node.js!"
    echo "Cai dat: https://nodejs.org/ (chon ban LTS)"
    echo "Hoac: brew install node (macOS) / sudo apt install nodejs (Ubuntu)"
    exit 1
fi

echo "[OK] Node.js $(node -v)"

# Install dependencies
echo ""
echo "[1/3] Dang cai dat thu vien..."
npm install --production
if [ $? -ne 0 ]; then
    echo "[LOI] Cai dat that bai!"
    exit 1
fi
echo "[OK] Thu vien da cai xong."

# Install Playwright
echo ""
echo "[2/3] Dang cai trinh duyet Chromium..."
npx playwright install chromium
echo "[OK] Trinh duyet da cai xong."

# Setup .env
echo ""
echo "[3/3] Cau hinh..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "[OK] Da tao file .env tu .env.example"
    echo ""
    echo "*** QUAN TRONG ***"
    echo "Mo file .env va dien:"
    echo "  - SUPABASE_SERVICE_ROLE_KEY"
    echo "  - SUPABASE_ANON_KEY"
    echo ""
    echo "Sau do chay: node agent.js"
else
    echo "[OK] File .env da ton tai."
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║    Cai dat hoan tat!                 ║"
echo "║    Chay: node agent.js               ║"
echo "╚══════════════════════════════════════╝"
echo ""
