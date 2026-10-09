# 自动化流程

该目录保存 VOZEB PRO 的 GitHub Actions 工作流，用于提交质量检查和amd64 容器镜像发布。

- `quality.yml`：检查主应用与文档站的格式、类型、测试、构建和发布条件。
- `docker-image.yml`：构建并发布主应用 amd64 镜像，并在版本标签完成后创建 GitHub Release、附加 SBOM。
- `docs-docker-image.yml`：构建并发布文档站 amd64 镜像。

`main` 分支用于持续集成，`v*` 标签用于正式版本镜像发布；版本标签还会创建同名 GitHub Release。镜像发布到当前仓库所有者的 GHCR 命名空间：`ghcr.io/<owner>/vozeb-pro` 和 `ghcr.io/<owner>/vozeb-pro-docs`。

## 生产 Runner

生产部署使用 GitHub self-hosted Runner，安装在 `192.168.11.160` 主机上，不要把 Runner 放进 `vozeb-pro` 或 `generation-worker` 容器。Runner 只需要主动访问 GitHub 的 HTTPS（443），不需要开放入站端口。

在仓库 `Settings → Actions → Runners → New self-hosted runner` 选择 **Linux / x64**，复制 GitHub 页面生成的一次性 token，在服务器执行（版本号以页面提示为准）：

```bash
sudo useradd --create-home --shell /bin/bash github-runner
sudo usermod --append --groups docker github-runner
sudo mkdir --parents /opt/actions-runner
sudo chown github-runner:github-runner /opt/actions-runner
sudo -iu github-runner
cd /opt/actions-runner
curl --fail --location --output actions-runner.tar.gz https://github.com/actions/runner/releases/download/v2.329.0/actions-runner-linux-x64-2.329.0.tar.gz
tar xzf actions-runner.tar.gz
./config.sh --url https://github.com/ZpitQ/VOZEB-PRO --token ONE_TIME_RUNNER_TOKEN --name vozeb-prod-160 --labels self-hosted,linux,x64,vozeb-prod --unattended
exit
sudo /opt/actions-runner/svc.sh install github-runner
sudo /opt/actions-runner/svc.sh start
```

确认 Runner 在线后，在仓库 `Settings → Environments` 创建 `production` 环境；建议启用 required reviewers。`.env`、数据库连接、`VOZEB_PRO_ENCRYPTION_KEY`、ADC JSON 等生产凭据留在服务器或 GitHub Secrets，不提交到仓库。

`.github/workflows/deploy-production.yml` 只允许手动触发：输入已发布的镜像 tag 后，Runner 在 `/home/VOZEB-PRO` 执行 `docker compose pull` 和 `docker compose up -d`。如果目录中存在 `docker-compose.gcp-adc.yml`，会自动作为第二个 Compose 文件加载。

