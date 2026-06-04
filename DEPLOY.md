# 固定网址部署说明

这个项目已经整理成可部署版本，可以放到 Render、Railway 或 VPS。

## 需要设置的环境变量

```text
ADMIN_ID=你的管理账号ID
ADMIN_PASSWORD=你的管理账号密码
ADMIN_NAME=显示昵称
DATA_DIR=/app/data
```

`DATA_DIR` 用来保存本地 JSON 数据。部署平台上请挂载持久化磁盘，否则平台重启后数据可能丢失。

## Render

1. 把本目录上传到 GitHub 仓库。
2. 在 Render 新建 Web Service，选择这个仓库。
3. Start Command 填：`node server.js`
4. 添加环境变量：`ADMIN_ID`、`ADMIN_PASSWORD`、`ADMIN_NAME`。
5. 添加 1GB Disk，挂载路径使用：`/opt/render/project/src/data`
6. 部署完成后，Render 会给一个固定 HTTPS 网址。

仓库里已经带了 `render.yaml`，也可以用 Blueprint 方式创建。

## Railway

1. 把本目录上传到 GitHub 仓库。
2. Railway 选择 Deploy from GitHub repo。
3. 添加环境变量：`ADMIN_ID`、`ADMIN_PASSWORD`、`ADMIN_NAME`、`DATA_DIR=/app/data`。
4. 如果需要长期保存数据，请在 Railway 项目里添加 Volume，并挂载到 `/app/data`。
5. 部署完成后，在 Settings/Networking 里生成公开域名。

## VPS / 云服务器

```bash
cd social-chat-platform
ADMIN_ID=yourid ADMIN_PASSWORD=yourpassword ADMIN_NAME=LinkJoy DATA_DIR=/opt/linkjoy-data node server.js
```

建议用 Nginx 反向代理到 `http://127.0.0.1:3000`，并配置 HTTPS。
