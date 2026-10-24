#!/usr/bin/env bash

set -Eeuo pipefail
umask 077

readonly INSTALLER_MARKER="# Managed by VOZEB PRO Ubuntu installer"
readonly DEFAULT_DOMAIN="www.ofidcglobal.com"
readonly DEFAULT_EMAIL="demirvolkan385@gmail.com"
readonly INSTALL_DIR="/opt/vozeb-pro"
readonly COMPOSE_PROJECT="vozeb-pro"
readonly APP_IMAGE="vozeb-pro:local"
readonly ACME_VERSION="3.1.4"
readonly ACME_COMMIT="3661fd86b6304115e42f43910e6dd452ab9866d6"
readonly ACME_HOME="/root/.acme.sh"
readonly LETSENCRYPT_DIRECTORY="https://acme-v02.api.letsencrypt.org/directory"

REPO_ROOT=""
DOMAIN=""
ACCOUNT_EMAIL=""
TEMP_DIR=""
FRESH_ENV=0
WAS_MANAGED=0
REUSE_NGINX=0

log() {
    printf '[VOZEB PRO] %s\n' "$*"
}

warn() {
    printf '[VOZEB PRO] 警告：%s\n' "$*" >&2
}

die() {
    printf '[VOZEB PRO] 错误：%s\n' "$*" >&2
    exit 1
}

cleanup() {
    local status=$?
    unset Ali_Key Ali_Secret
    if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" && "$TEMP_DIR" == /tmp/vozeb-pro-acme.* ]]; then
        rm -rf -- "$TEMP_DIR"
    fi
    return "$status"
}
trap cleanup EXIT

usage() {
    cat <<'EOF'
用法：sudo bash deploy/install-ubuntu.sh

支持环境：Ubuntu 24.04/26.04 x86_64，全新服务器或复用现有 VOZEB PRO Nginx 站点。
脚本会通过仓库根目录 Dockerfile 构建本地 VOZEB PRO 镜像，并部署 PostgreSQL、generation-worker、
Nginx，以及 acme.sh + 阿里云 DNS API 的 Let's Encrypt ECC 证书。
EOF
}

validate_domain() {
    local value="$1"
    local label
    local -a labels

    [[ ${#value} -le 253 && "$value" == *.* && "$value" != *..* ]] || return 1
    IFS='.' read -r -a labels <<<"$value"
    for label in "${labels[@]}"; do
        [[ "$label" =~ ^([a-z0-9]|[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$ ]] || return 1
    done
}

validate_email() {
    [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

check_platform() {
    [[ ${EUID:-$(id -u)} -eq 0 ]] || die "请使用 root 执行此脚本。"
    [[ -t 0 ]] || die "首次部署必须在交互式终端中执行。"
    [[ -r /etc/os-release ]] || die "无法读取 /etc/os-release。"

    # shellcheck disable=SC1091
    source /etc/os-release
    [[ "${ID:-}" == "ubuntu" ]] || die "仅支持 Ubuntu。"
    case "${VERSION_ID:-}:${VERSION_CODENAME:-}" in
        24.04:noble|26.04:resolute) ;;
        *) die "仅支持 Ubuntu 24.04/26.04。" ;;
    esac
    [[ "$(uname -m)" == "x86_64" ]] || die "仅支持 x86_64 架构。"
}

resolve_repo_root() {
    local script_dir
    script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
    REPO_ROOT="$(cd -- "$script_dir/.." && pwd -P)"
    [[ -f "$REPO_ROOT/Dockerfile" && -f "$REPO_ROOT/docker-compose.local.yml" && -f "$REPO_ROOT/.env.example" && -f "$REPO_ROOT/deploy/nginx/vozeb-pro.conf.example" ]] ||
        die "请从完整的 VOZEB PRO 仓库中运行脚本。"
}

collect_inputs() {
    local input=""
    local confirmed=""

    read -r -p "站点域名 [$DEFAULT_DOMAIN]：" input
    DOMAIN="${input:-$DEFAULT_DOMAIN}"
    DOMAIN="${DOMAIN,,}"
    validate_domain "$DOMAIN" || die "域名格式无效：$DOMAIN"

    input=""
    read -r -p "ACME 通知邮箱 [$DEFAULT_EMAIL]：" input
    ACCOUNT_EMAIL="${input:-$DEFAULT_EMAIL}"
    validate_email "$ACCOUNT_EMAIL" || die "邮箱格式无效：$ACCOUNT_EMAIL"

    printf '\n将部署：\n  域名：%s\n  本地构建：%s → %s\n  目录：%s\n  证书：Let\x27s Encrypt ECC P-256，仅包含该域名\n\n' "$DOMAIN" "$REPO_ROOT/Dockerfile" "$APP_IMAGE" "$INSTALL_DIR"
    read -r -p "确认继续？[y/N] " confirmed
    [[ "$confirmed" == "y" || "$confirmed" == "Y" ]] || exit 0
}

check_unmanaged_collisions() {
    local install_real
    local repo_real
    local managed_path

    install_real="$(realpath -m "$INSTALL_DIR")"
    repo_real="$(realpath -m "$REPO_ROOT")"
    [[ -f "$INSTALL_DIR/.managed-by-vozeb-pro-installer" ]] && WAS_MANAGED=1

    if [[ -d "$INSTALL_DIR" && "$install_real" != "$repo_real" && $WAS_MANAGED -eq 0 ]] &&
        [[ -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
        die "$INSTALL_DIR 已存在且不属于本脚本，拒绝覆盖。"
    fi

    if [[ -e /etc/nginx/sites-enabled/vozeb-pro.conf && ! -L /etc/nginx/sites-enabled/vozeb-pro.conf ]]; then
        die "发现非本脚本管理的 Nginx 启用配置：/etc/nginx/sites-enabled/vozeb-pro.conf"
    fi

    if [[ -f /etc/nginx/sites-available/vozeb-pro.conf ]]; then
        local available=/etc/nginx/sites-available/vozeb-pro.conf
        local enabled=/etc/nginx/sites-enabled/vozeb-pro.conf
        local expected
        grep -Fq "$INSTALLER_MARKER" "$available" || die "发现非本脚本管理的 Nginx 配置：$available"
        [[ -L "$enabled" && "$(readlink -f "$enabled")" == "$available" ]] || die "现有 VOZEB PRO Nginx 站点未正确启用。"
        for expected in "server_name $DOMAIN;" "server 127.0.0.1:3000;" \
            "ssl_certificate /etc/nginx/ssl/$DOMAIN/fullchain.pem;" \
            "ssl_certificate_key /etc/nginx/ssl/$DOMAIN/key.pem;"; do
            grep -Fq "$expected" "$available" || die "现有 Nginx 站点与域名、上游或证书路径不匹配：$expected"
        done
        REUSE_NGINX=1
    fi

    for managed_path in /usr/local/sbin/vozeb-pro-nginx-reload /etc/systemd/system/vozeb-pro-acme-renew.service /etc/systemd/system/vozeb-pro-acme-renew.timer; do
        if [[ -e "$managed_path" ]] && ! grep -Fq "$INSTALLER_MARKER" "$managed_path"; then
            die "发现非本脚本管理的文件：$managed_path"
        fi
    done

    if [[ -d "$ACME_HOME" && ! -f "$ACME_HOME/.managed-by-vozeb-pro-installer" ]] &&
        [[ -n "$(find "$ACME_HOME" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
        die "$ACME_HOME 已包含其他 acme.sh 配置，脚本不会接管或覆盖。"
    fi

    if [[ $WAS_MANAGED -eq 0 && -e "$INSTALL_DIR/.env" ]]; then
        die "发现非本脚本管理的 $INSTALL_DIR/.env，拒绝覆盖。"
    fi

    if [[ $WAS_MANAGED -eq 0 && $REUSE_NGINX -eq 0 ]] && command -v ss >/dev/null 2>&1 && ss -H -ltn | awk '{print $4}' | grep -Eq ':(80|443)$'; then
        die "80 或 443 端口已被占用；请先确认现有服务，脚本不会自动替换。"
    fi
}

install_base_packages() {
    export DEBIAN_FRONTEND=noninteractive
    log "安装基础依赖和 Nginx"
    apt-get update -o APT::Update::Error-Mode=any
    apt-get install -y ca-certificates curl git gnupg nginx openssl
}

install_docker() {
    local conflicting=""

    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        log "复用现有 Docker Engine 与 Compose v2"
    else
        conflicting="$(dpkg-query -W -f='${binary:Package}\n' docker.io docker-compose docker-compose-v2 podman-docker containerd runc 2>/dev/null || true)"
        [[ -z "$conflicting" ]] || die "发现可能冲突的容器软件包，拒绝自动卸载：${conflicting//$'\n'/, }"

        log "从 Docker 官方 APT 仓库安装 Docker Engine 与 Compose v2"
        install -d -m 0755 /etc/apt/keyrings
        curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
        printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.sources
        apt-get update -o APT::Update::Error-Mode=any
        apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    fi

    systemctl enable --now docker
    systemctl enable --now nginx
}

check_docker_collisions() {
    local name
    local volume

    [[ $WAS_MANAGED -eq 1 ]] && return
    for name in vozeb-pro vozeb-pro-postgres vozeb-pro-generation-worker; do
        if docker container inspect "$name" >/dev/null 2>&1; then
            die "发现非本脚本管理的同名容器：$name"
        fi
    done
    for volume in vozeb-pro_vozeb-pro-data vozeb-pro_vozeb-pro-postgres; do
        if docker volume inspect "$volume" >/dev/null 2>&1; then
            die "发现非本脚本管理的同名数据卷：$volume"
        fi
    done
}

env_value() {
    local key="$1"
    sed -n "s/^${key}=//p" "$INSTALL_DIR/.env" | tail -n 1
}

set_env() {
    local key="$1"
    local value="$2"
    local escaped="$value"

    escaped="${escaped//\\/\\\\}"
    escaped="${escaped//|/\\|}"
    if grep -q "^${key}=" "$INSTALL_DIR/.env"; then
        sed -i "s|^${key}=.*|${key}=${escaped}|" "$INSTALL_DIR/.env"
    else
        printf '%s=%s\n' "$key" "$value" >>"$INSTALL_DIR/.env"
    fi
}

ensure_secret() {
    local key="$1"
    local current
    current="$(env_value "$key")"
    if [[ -n "$current" ]]; then
        return
    fi
    if [[ $FRESH_ENV -eq 0 ]]; then
        die "既有部署缺少 $key；为保护现有数据，脚本不会生成替代值。"
    fi
    set_env "$key" "$(openssl rand -hex 32)"
}

prepare_application_config() {
    local install_real
    local repo_real

    install_real="$(realpath -m "$INSTALL_DIR")"
    repo_real="$(realpath -m "$REPO_ROOT")"
    install -d -m 0750 "$INSTALL_DIR"
    if [[ "$install_real" != "$repo_real" ]]; then
        install -m 0644 "$REPO_ROOT/docker-compose.local.yml" "$INSTALL_DIR/docker-compose.local.yml"
    fi

    if [[ ! -f "$INSTALL_DIR/.env" ]]; then
        install -m 0600 "$REPO_ROOT/.env.example" "$INSTALL_DIR/.env"
        FRESH_ENV=1
    else
        chmod 0600 "$INSTALL_DIR/.env"
    fi

    set_env COMPOSE_PROJECT_NAME "$COMPOSE_PROJECT"
    set_env NEXT_PUBLIC_SITE_URL "https://$DOMAIN"
    set_env VOZEB_PRO_IMAGE "$APP_IMAGE"
    set_env VOZEB_PRO_APP_BIND 127.0.0.1
    set_env POSTGRES_DB vozeb_pro
    set_env POSTGRES_USER vozeb_pro
    set_env VOZEB_PRO_DATABASE_PROVIDER postgres
    set_env VOZEB_PRO_DATABASE_SSL 0
    set_env VOZEB_PRO_TRUSTED_PROXY_HOPS 1
    ensure_secret POSTGRES_PASSWORD
    ensure_secret VOZEB_PRO_ENCRYPTION_KEY
    ensure_secret VOZEB_PRO_MAINTENANCE_TOKEN
    ensure_secret VOZEB_PRO_WORKER_TOKEN
    if [[ $FRESH_ENV -eq 1 ]]; then
        set_env VOZEB_PRO_INSTALL_TOKEN "$(openssl rand -hex 32)"
    fi

    printf 'version=1\ndomain=%s\n' "$DOMAIN" >"$INSTALL_DIR/.managed-by-vozeb-pro-installer"
    chmod 0600 "$INSTALL_DIR/.env" "$INSTALL_DIR/.managed-by-vozeb-pro-installer"
}

compose() {
    VOZEB_PRO_BUILD_CONTEXT="$REPO_ROOT" VOZEB_PRO_APP_BIND=127.0.0.1 docker compose --project-directory "$INSTALL_DIR" --env-file "$INSTALL_DIR/.env" -p "$COMPOSE_PROJECT" -f "$INSTALL_DIR/docker-compose.local.yml" "$@"
}

start_application() {
    log "校验配置并通过 Dockerfile 构建本地镜像 $APP_IMAGE"
    compose config >/dev/null
    compose build app
    log "启动 VOZEB PRO、PostgreSQL 与 generation-worker"
    compose up -d --no-build --wait
    curl -fsS http://127.0.0.1:3000/api/health/live >/dev/null
}

install_acme() {
    local source_dir

    TEMP_DIR="$(mktemp -d /tmp/vozeb-pro-acme.XXXXXX)"
    if [[ -f "$ACME_HOME/.managed-by-vozeb-pro-installer" ]]; then
        [[ -x "$ACME_HOME/acme.sh" ]] || die "现有 acme.sh 安装不完整。"
        grep -Fxq "version=$ACME_VERSION" "$ACME_HOME/.managed-by-vozeb-pro-installer" || die "现有 acme.sh 版本与脚本不一致。"
        grep -Fxq "commit=$ACME_COMMIT" "$ACME_HOME/.managed-by-vozeb-pro-installer" || die "现有 acme.sh 提交与脚本不一致。"
        dns_credentials_ready || die "现有 acme.sh 缺少阿里云 DNS 续期凭据。"
        log "复用现有 acme.sh 与证书续期配置"
        return
    fi
    source_dir="$TEMP_DIR/source"
    log "安装固定版本 acme.sh $ACME_VERSION"
    git clone --quiet --depth 1 --branch "$ACME_VERSION" https://github.com/acmesh-official/acme.sh.git "$source_dir"
    [[ "$(git -C "$source_dir" rev-parse HEAD)" == "$ACME_COMMIT" ]] || die "acme.sh 提交校验失败。"
    (
        cd "$source_dir"
        ./acme.sh --install --home "$ACME_HOME" --config-home "$ACME_HOME" --no-cron --no-profile --email "$ACCOUNT_EMAIL"
    )
    printf 'version=%s\ncommit=%s\n' "$ACME_VERSION" "$ACME_COMMIT" >"$ACME_HOME/.managed-by-vozeb-pro-installer"
    chmod 0700 "$ACME_HOME"
    chmod 0600 "$ACME_HOME/.managed-by-vozeb-pro-installer"
    [[ ! -f "$ACME_HOME/account.conf" ]] || chmod 0600 "$ACME_HOME/account.conf"
}

dns_credentials_ready() {
    local account="$ACME_HOME/account.conf"
    [[ -f "$account" ]] &&
        grep -Eq '^SAVED_Ali_Key=.+' "$account" &&
        grep -Eq '^SAVED_Ali_Secret=.+' "$account"
}

write_reload_helper() {
    local helper_tmp="$TEMP_DIR/nginx-reload"
    cat >"$helper_tmp" <<'EOF'
#!/usr/bin/env bash
# Managed by VOZEB PRO Ubuntu installer
set -Eeuo pipefail
/usr/sbin/nginx -t
/usr/bin/systemctl reload nginx
EOF
    install -m 0755 "$helper_tmp" /usr/local/sbin/vozeb-pro-nginx-reload
}

production_certificate_ready() {
    local domain_home="$ACME_HOME/${DOMAIN}_ecc"
    local domain_conf="$domain_home/${DOMAIN}.conf"

    [[ -s "$domain_home/fullchain.cer" && -s "$domain_home/${DOMAIN}.key" && -s "$domain_conf" ]] || return 1
    grep -Fq "Le_API='$LETSENCRYPT_DIRECTORY'" "$domain_conf" || return 1
    openssl x509 -in "$domain_home/fullchain.cer" -noout -checkend 0 >/dev/null 2>&1
}

issue_certificate_if_needed() {
    local acme="$ACME_HOME/acme.sh"

    if production_certificate_ready; then
        log "复用现有且未过期的 Let's Encrypt 生产证书"
        return
    fi

    read -r -p "阿里云 RAM AccessKey ID：" Ali_Key
    read -r -s -p "阿里云 RAM AccessKey Secret：" Ali_Secret
    printf '\n'
    [[ -n "$Ali_Key" && -n "$Ali_Secret" ]] || die "AccessKey ID 和 Secret 都不能为空。"
    export Ali_Key Ali_Secret

    log "使用 Let's Encrypt staging 验证阿里云 DNS 权限与解析传播"
    "$acme" --issue --server letsencrypt_test --dns dns_ali -d "$DOMAIN" --keylength ec-256 --force
    log "签发 Let's Encrypt 生产证书"
    "$acme" --issue --server letsencrypt --dns dns_ali -d "$DOMAIN" --keylength ec-256 --force
    unset Ali_Key Ali_Secret
    chmod 0600 "$ACME_HOME/account.conf"
    dns_credentials_ready || die "acme.sh 未保存阿里云 DNS 续期凭据。"
}

install_certificate() {
    local cert_dir="/etc/nginx/ssl/$DOMAIN"
    local acme="$ACME_HOME/acme.sh"

    install -d -m 0700 "$cert_dir"
    if [[ ! -e "$cert_dir/key.pem" ]]; then
        install -m 0600 /dev/null "$cert_dir/key.pem"
    fi
    if [[ ! -e "$cert_dir/fullchain.pem" ]]; then
        install -m 0644 /dev/null "$cert_dir/fullchain.pem"
    fi
    chmod 0600 "$cert_dir/key.pem"
    chmod 0644 "$cert_dir/fullchain.pem"

    "$acme" --install-cert -d "$DOMAIN" --ecc \
        --key-file "$cert_dir/key.pem" \
        --fullchain-file "$cert_dir/fullchain.pem" \
        --reloadcmd "/usr/local/sbin/vozeb-pro-nginx-reload"
}

configure_nginx() {
    local available="/etc/nginx/sites-available/vozeb-pro.conf"
    local enabled="/etc/nginx/sites-enabled/vozeb-pro.conf"
    local rendered="$TEMP_DIR/vozeb-pro.conf"
    local enabled_target=""
    local backup="$TEMP_DIR/vozeb-pro.conf.previous"
    local had_available=0
    local created_link=0

    if [[ $REUSE_NGINX -eq 1 ]]; then
        nginx -t
        log "复用现有 VOZEB PRO Nginx 站点配置"
        return
    fi

    render_nginx_config "$rendered"
    if [[ -L "$enabled" ]]; then
        enabled_target="$(readlink -f "$enabled" || true)"
        [[ "$enabled_target" == "$available" ]] || die "$enabled 已指向其他配置，拒绝覆盖。"
    elif [[ -e "$enabled" ]]; then
        die "$enabled 已存在且不是符号链接，拒绝覆盖。"
    fi
    if [[ -f "$available" ]]; then
        cp -a "$available" "$backup"
        had_available=1
    fi

    install -m 0644 "$rendered" "$available"
    if [[ ! -L "$enabled" ]]; then
        ln -s "$available" "$enabled"
        created_link=1
    fi

    if ! nginx -t; then
        if [[ $had_available -eq 1 ]]; then
            cp -a "$backup" "$available"
        else
            rm -f -- "$available"
        fi
        if [[ $created_link -eq 1 ]]; then
            rm -f -- "$enabled"
        fi
        die "Nginx 配置校验失败，已恢复执行前状态。"
    fi
    systemctl reload nginx
}

render_nginx_config() {
    local rendered="$1"
    printf '%s\n' "$INSTALLER_MARKER" >"$rendered"
    sed -e "s/vozeb-pro\.example\.com/$DOMAIN/g" \
        -e "s|/www/server/panel/vhost/cert/$DOMAIN/fullchain.pem|/etc/nginx/ssl/$DOMAIN/fullchain.pem|" \
        -e "s|/www/server/panel/vhost/cert/$DOMAIN/privkey.pem|/etc/nginx/ssl/$DOMAIN/key.pem|" \
        "$REPO_ROOT/deploy/nginx/vozeb-pro.conf.example" >>"$rendered"
}

configure_ufw() {
    if ! command -v ufw >/dev/null 2>&1; then
        log "UFW 未安装，不做防火墙变更"
        return
    fi
    if LC_ALL=C ufw status | grep -q '^Status: active'; then
        log "UFW 已启用，确保放行 80/tcp 与 443/tcp"
        ufw allow 80/tcp
        ufw allow 443/tcp
    else
        log "UFW 未启用，不自动启用"
    fi
}

configure_acme_timer() {
    local service_tmp="$TEMP_DIR/vozeb-pro-acme-renew.service"
    local timer_tmp="$TEMP_DIR/vozeb-pro-acme-renew.timer"

    cat >"$service_tmp" <<EOF
# Managed by VOZEB PRO Ubuntu installer
[Unit]
Description=Renew VOZEB PRO TLS certificate with acme.sh
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$ACME_HOME/acme.sh --cron --home $ACME_HOME --config-home $ACME_HOME
EOF

    cat >"$timer_tmp" <<'EOF'
# Managed by VOZEB PRO Ubuntu installer
[Unit]
Description=Check VOZEB PRO TLS certificate renewal

[Timer]
OnCalendar=*-*-* 00/6:00:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

    install -m 0644 "$service_tmp" /etc/systemd/system/vozeb-pro-acme-renew.service
    install -m 0644 "$timer_tmp" /etc/systemd/system/vozeb-pro-acme-renew.timer
    systemctl daemon-reload
    systemctl enable --now vozeb-pro-acme-renew.timer
}

show_dns_records() {
    local records
    records="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u || true)"
    if [[ -n "$records" ]]; then
        log "$DOMAIN 当前解析到：${records//$'\n'/, }"
    else
        warn "未查询到 $DOMAIN 的 IPv4 记录；证书可通过 DNS-01 签发，但站点无法正常直连。"
    fi
    warn "请同时确认云安全组已允许公网访问 80/tcp 和 443/tcp。"
}

verify_https_live() {
    curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health/live" >/dev/null
    if ! curl -fsS "https://$DOMAIN/api/health/live" >/dev/null; then
        warn "服务器本地 TLS 验证通过，但通过公网解析访问失败；请检查 A 记录、云安全组和回源网络。"
    fi
}

complete_installation() {
    local ready_url="https://$DOMAIN/api/health/ready"
    local install_token

    if ! curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "$ready_url" >/dev/null 2>&1; then
        install_token="$(env_value VOZEB_PRO_INSTALL_TOKEN)"
        [[ -n "$install_token" ]] || die "站点尚未就绪，但一次性安装令牌已被移除。"
        printf '\n请打开 https://%s/install 完成数据库初始化并创建首个管理员。\n一次性安装令牌：%s\n\n' "$DOMAIN" "$install_token"
        read -r -p "完成后按 Enter 继续验收。" _
        curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "$ready_url" >/dev/null ||
            die "就绪检查未通过；安装令牌已保留，请检查 /install 和容器日志后重试。"
    fi

    if [[ -n "$(env_value VOZEB_PRO_INSTALL_TOKEN)" ]]; then
        log "移除一次性安装令牌并安全重建 App"
        set_env VOZEB_PRO_INSTALL_TOKEN ""
        chmod 0600 "$INSTALL_DIR/.env"
        compose up -d --no-build --wait app
    fi

    curl -fsS --resolve "$DOMAIN:443:127.0.0.1" "$ready_url" >/dev/null
    compose ps
    printf '\n部署完成：\n  站点：https://%s\n  配置：%s/.env\n  证书续期：systemctl status vozeb-pro-acme-renew.timer\n' "$DOMAIN" "$INSTALL_DIR"
}

main() {
    if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
        usage
        exit 0
    fi
    [[ $# -eq 0 ]] || die "未知参数。使用 --help 查看说明。"

    check_platform
    resolve_repo_root
    collect_inputs
    check_unmanaged_collisions
    install_base_packages
    install_docker
    check_docker_collisions
    prepare_application_config
    start_application
    install_acme
    write_reload_helper
    issue_certificate_if_needed
    install_certificate
    configure_nginx
    configure_ufw
    configure_acme_timer
    show_dns_records
    verify_https_live
    complete_installation
}

main "$@"
