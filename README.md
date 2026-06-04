# 即时通讯社交平台

一个轻量级 B/S Web 项目：账号好友、私聊、管理员专属已读状态、个人动态，以及内置“你画我猜”和“炸弹猫”多人房间。

当前版本支持：

- 登录用户可浏览公共空间
- 动态点赞、删除自己的动态
- 发帖人可看到点赞名单，帖子支持评论
- 好友聊天支持文字和图片
- 支持创建群聊并发送群消息
- 游戏房间支持进入、邀请好友、删除自己创建的房间
- 炸弹猫会显示自己的手牌，你画我猜支持网页画布、画笔颜色、撤回，并只让画手看到关键词
- 新增跳一跳接龙游戏
- 已整理 Dockerfile、Render、Railway、VPS 部署说明

## 一键启动

Windows 可直接双击：

```text
start.bat
```

或在命令行运行：

```powershell
node server.js
```

浏览器访问：

```text
http://localhost:3000
```

如果端口被占用：

```powershell
$env:PORT=3100; node server.js
```

## 数据存储

所有数据会保存在本地：

```text
data/db.json
```

包含用户、好友关系、申请、聊天记录、动态、拉黑列表、游戏房间等。

正式部署请看：

```text
DEPLOY.md
```

## 项目结构

```text
server.js          后端接口、实时通道、本地持久化
public/index.html  前端入口
public/styles.css  页面样式
public/app.js      前端交互逻辑
```
