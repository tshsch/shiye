#!/bin/bash
set -e
echo "==> 检查 Node.js（需要 >= 22.5，用于内置 SQLite）"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  V=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$V" -ge 22 ]; then NEED_NODE=0; fi
fi
if [ "$NEED_NODE" = "1" ]; then
  echo "==> 安装 Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> 项目目录: $REPO_DIR"

if [ ! -f "$REPO_DIR/.env" ]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  echo "==> 已生成 $REPO_DIR/.env —— 请编辑填入你的 LLM_API_KEY（nano $REPO_DIR/.env），然后: systemctl restart shiye"
fi

echo "==> 注册 systemd 服务"
cat > /etc/systemd/system/shiye.service <<EOF
[Unit]
Description=Shiye reading agent
After=network.target

[Service]
WorkingDirectory=$REPO_DIR
ExecStart=$(command -v node) $REPO_DIR/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now shiye
sleep 2
systemctl --no-pager status shiye | head -5

IP=$(curl -s ifconfig.me || echo 你的服务器IP)
echo ""
echo "=============================================="
echo "  部署完成!"
echo "  本机访问: http://127.0.0.1:3000"
echo "  公网访问: http://$IP:3000"
echo "  记得在云控制台安全组放行 TCP 3000"
echo "  查看日志: journalctl -u shiye -f"
echo "  改代码后重启: systemctl restart shiye"
echo "=============================================="