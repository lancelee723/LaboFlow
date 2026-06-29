#!/usr/bin/env bash
# LaboFlow Docker 镜像管理脚本
# Powered by Lance

set -o pipefail

# ============================================================
# 配置区（按需修改）
# ============================================================

# 私有镜像仓库地址（含命名空间），留空则在推送前提示输入。
# 格式: <registry-host>/<namespace>
# 示例: crpi-xxxxx.cn-guangzhou.personal.cr.aliyuncs.com/laboflow
REGISTRY="crpi-oxztsn6qggvtnlnf.cn-guangzhou.personal.cr.aliyuncs.com/laboflow"

# 默认镜像 tag 示例（仅作输入提示；每次构建必须显式输入符合 SemVer X.Y.Z 的版本号）
DEFAULT_TAG="1.0.0"

# Linux apt 源地址（仅影响 Dockerfile 内 Debian/apt 源，不影响 Docker 镜像源）
LINUX_MIRROR="mirrors.tuna.tsinghua.edu.cn"

# Docker Hub 镜像加速源（用于 Dockerfile FROM 拉取基础镜像）
# 可选值: docker.1ms.run, docker.m.daocloud.io, docker.io（直连，无加速）
DOCKER_MIRROR="docker.1ms.run"

# 供需要完整 URL 的 Dockerfile 使用，留空则保持上游默认源。
# 示例: http://mirrors.tuna.tsinghua.edu.cn
APT_MIRROR=""

# Go module 代理（用于 WeKnora 的 Dockerfile.app 内 go mod download / go install）
# 国内可用值: https://goproxy.cn,direct  https://goproxy.io,direct
# 国外直连:   https://proxy.golang.org,direct
GOPROXY="https://goproxy.cn,direct"

# 镜像清单：name|context_dir|dockerfile（相对仓库根目录）
# 新增镜像在此追加一行即可，菜单会自动出现。
IMAGES=(
  "clawith-backend|Clawith/backend|Clawith/backend/Dockerfile"
  "clawith-frontend|Clawith/frontend|Clawith/frontend/Dockerfile"
  "clawith-bridge|Clawith/bridge|Clawith/bridge/Dockerfile"
  "weknora-app|WeKnora|WeKnora/docker/Dockerfile.app"
  "weknora-docreader|WeKnora|WeKnora/docker/Dockerfile.docreader"
  "weknora-frontend|WeKnora/frontend|WeKnora/frontend/Dockerfile.laboflow"
  "nginx|nginx|nginx/Dockerfile"
  "pro-slides|Pro Slides|Pro Slides/Dockerfile"
  "pptmaster-worker|PPT-Master|PPT-Master/docker/Dockerfile.worker"
  "pptmaster-webui|PPT-Master|PPT-Master/docker/Dockerfile.webui"
)

# 敏感文件模式：构建上下文中若存在且未被 .dockerignore 排除则拒绝构建
SENSITIVE_PATTERNS=(
  ".env" ".env.local" ".env.production" ".env.development"
  "*.key" "*.pem" "ss-nodes.json"
  "agent_data" "node_modules"
  "docker/.env" "docker/.env.*"
  "data-files" "docreader-tmp" "postgres-data" "minio_data" "neo4j-data" "qdrant_data"
  "*.db" "*.sqlite" "*.sqlite3" "*.sqlite-wal" "*.sqlite-shm"
  "uploads" "upload" "chunks" "chunk" "user_data" "userdata"
)

# Buildx builder 名称
BUILDX_BUILDER="laboflow-builder"

# ============================================================
# 颜色 / UI
# ============================================================

ESC=$'\033'
RESET="${ESC}[0m"
BOLD="${ESC}[1m"
DIM="${ESC}[2m"
RED="${ESC}[38;5;196m"
YELLOW="${ESC}[38;5;220m"
GREEN="${ESC}[38;5;46m"
CYAN="${ESC}[38;5;51m"
MAGENTA="${ESC}[38;5;201m"
GRAY="${ESC}[38;5;245m"

# 真彩渐变（青→品红→绿，赛博朋克配色）
gradient_text() {
  local text="$1"
  local len=${#text}
  local i
  local out=""
  # 三段渐变：cyan(0,255,255) -> magenta(255,0,255) -> green(0,255,128)
  local r g b ratio seg seg_len
  for ((i = 0; i < len; i++)); do
    local ch="${text:$i:1}"
    if (( i < len / 2 )); then
      seg_len=$((len / 2)); seg=$i
      ratio=$(( seg * 100 / (seg_len == 0 ? 1 : seg_len) ))
      r=$(( 0 + (255 - 0) * ratio / 100 ))
      g=$(( 255 + (0 - 255) * ratio / 100 ))
      b=255
    else
      seg_len=$((len - len / 2)); seg=$((i - len / 2))
      ratio=$(( seg * 100 / (seg_len == 0 ? 1 : seg_len) ))
      r=$(( 255 + (0 - 255) * ratio / 100 ))
      g=$(( 0 + (255 - 0) * ratio / 100 ))
      b=$(( 255 + (128 - 255) * ratio / 100 ))
    fi
    out+="${ESC}[1;38;2;${r};${g};${b}m${ch}"
  done
  printf "%s%s" "$out" "$RESET"
}

# 头部标识区（每级菜单都打）
print_header() {
  clear
  local width=54
  local line
  line=$(printf '=%.0s' $(seq 1 $width))
  printf "${CYAN}%s${RESET}\n" "$line"
  # 标题行（渐变）
  local title="LaboFlow Docker 镜像管理脚本"
  local title_visual_len=28   # 中文按 2 宽：LaboFlow Docker(16) + 镜像管理脚本(6×2=12)
  local pad_total=$((width - 2 - title_visual_len))
  local pad_left=$((pad_total / 2))
  local pad_right=$((pad_total - pad_left))
  printf "${CYAN}|${RESET}%*s" "$pad_left" ""
  gradient_text "$title"
  printf "%*s${CYAN}|${RESET}\n" "$pad_right" ""
  # 副标题
  local sub="V26.7.1  Powered by Lance"
  local sub_len=${#sub}
  local sub_pad_total=$((width - 2 - sub_len))
  local sub_pad_left=$((sub_pad_total / 2))
  local sub_pad_right=$((sub_pad_total - sub_pad_left))
  printf "${CYAN}|${RESET}%*s${BOLD}${MAGENTA}%s${RESET}%*s${CYAN}|${RESET}\n" \
    "$sub_pad_left" "" "$sub" "$sub_pad_right" ""
  printf "${CYAN}%s${RESET}\n" "$line"
  printf "${YELLOW} >> 提示：请谨慎使用脚本各项功能，以免影响产品使用 <<${RESET}\n"
  printf "${CYAN}%s${RESET}\n\n" "$line"
}

info()  { printf "${CYAN}[i]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[✓]${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[!]${RESET} %s\n" "$*"; }
err()   { printf "${RED}[✗]${RESET} %s\n" "$*"; }

prompt() {
  local msg="$1"
  printf "${BOLD}${GREEN}%s${RESET} " "$msg"
}

pause_return() {
  echo
  printf "${DIM}按回车返回...${RESET}"
  read -r _
}

# bash 3.2 兼容的数组成员检查（替代关联数组）
_in_array() {
  local needle="$1"
  shift
  local e
  for e in "$@"; do
    [[ "$e" == "$needle" ]] && return 0
  done
  return 1
}

# ============================================================
# 工具函数
# ============================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { err "缺少命令: $1"; return 1; }
}

ensure_buildx() {
  require_cmd docker || return 1
  if ! docker buildx version >/dev/null 2>&1; then
    err "未检测到 docker buildx，请升级 Docker Desktop 或安装 buildx 插件。"
    return 1
  fi
  if ! docker buildx inspect "$BUILDX_BUILDER" >/dev/null 2>&1; then
    info "创建 buildx builder: $BUILDX_BUILDER"
    docker buildx create --name "$BUILDX_BUILDER" --driver docker-container --use >/dev/null
  else
    docker buildx use "$BUILDX_BUILDER" >/dev/null
  fi
  docker buildx inspect --bootstrap >/dev/null 2>&1 || true
}

# 检查构建上下文中的敏感文件是否被 .dockerignore 排除
check_sensitive() {
  local ctx="$1"
  local ignore_file="${ctx}/.dockerignore"
  local found=()
  for pat in "${SENSITIVE_PATTERNS[@]}"; do
    local finder=(-maxdepth 6)
    if [[ "$pat" == */* ]]; then
      finder+=( -path "*/$pat" )
    else
      finder+=( -name "$pat" )
    fi
    while IFS= read -r -d '' f; do
      local rel="${f#$ctx/}"
      if [[ -f "$ignore_file" ]] && grep -qF "$pat" "$ignore_file"; then
        continue
      fi
      # 简易匹配：若 .dockerignore 含基础文件名也认为安全（例如 uploads/）
      local base
      base="$(basename "$pat")"
      if [[ -f "$ignore_file" ]] && grep -qF "$base" "$ignore_file"; then
        continue
      fi
      found+=("$rel")
    done < <(find "$ctx" "${finder[@]}" -print0 2>/dev/null)
  done
  if (( ${#found[@]} > 0 )); then
    warn "构建上下文 [$ctx] 检测到可能含敏感数据的文件且未在 .dockerignore 排除："
    printf '    ${RED}- %s${RESET}\n' "${found[@]}"
    prompt "是否仍继续构建？(y/N):"
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]]
    return $?
  fi
  return 0
}

# 通过 name 取镜像配置
image_meta() {
  local name="$1"
  for entry in "${IMAGES[@]}"; do
    IFS='|' read -r n ctx df <<<"$entry"
    if [[ "$n" == "$name" ]]; then
      echo "$ctx|$df"
      return 0
    fi
  done
  return 1
}

# 解析平台
platforms_for_choice() {
  case "$1" in
    1) echo "linux/amd64,linux/arm64" ;;
    2) echo "linux/amd64" ;;
    3) echo "linux/arm64" ;;
    *) return 1 ;;
  esac
}

docker_mirror_label() {
  case "$1" in
    docker.1ms.run) echo "1ms 镜像加速" ;;
    docker.m.daocloud.io) echo "DaoCloud 镜像加速" ;;
    docker.io) echo "Docker Hub 直连（无加速）" ;;
    *) echo "$1" ;;
  esac
}

linux_mirror_label() {
  case "$1" in
    deb.debian.org) echo "Debian 官方源" ;;
    mirrors.tuna.tsinghua.edu.cn) echo "清华 TUNA 源" ;;
    mirrors.ustc.edu.cn) echo "中科大 USTC 源" ;;
    *) echo "$1" ;;
  esac
}

host_platform() {
  local os arch
  os=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m 2>/dev/null)

  case "$arch" in
    x86_64|amd64) arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) return 1 ;;
  esac

  # 镜像构建目标统一使用 linux 平台。
  if [[ "$os" == "darwin" || "$os" == "linux" ]]; then
    echo "linux/${arch}"
    return 0
  fi

  return 1
}

platform_label() {
  case "$1" in
    linux/amd64) echo "Linux-AMD64（适用于 Linux/Windows 的 X86-64 架构）" ;;
    linux/arm64) echo "ARM64（适用于 M 系列芯片 Mac / ARM Linux）" ;;
    linux/amd64,linux/arm64) echo "通用架构（包括 ARM 和 X86-64）" ;;
    *) echo "$1" ;;
  esac
}

menu_push_arch_select() {
  print_header
  echo "${BOLD}${CYAN}>> 推送远程镜像 / 选择架构${RESET}"
  echo
  echo "  1. 通用架构（包括 ARM 和 X86-64）"
  echo "  2. Linux-AMD64 架构（适用于 Linux 或 Windows 的 X86-64 架构）"
  echo "  3. ARM 架构（适用于 M 系列芯片的 Mac 设备）"
  echo "  0. 返回上级"
  echo
  prompt "请输入你的选项（默认 1）："
  read -r c
  c="${c:-1}"
  case "$c" in
    0) return 1 ;;
    1|2|3) _ARCH_CHOICE="$c"; return 0 ;;
    *) err "无效选项"; sleep 1; return 2 ;;
  esac
}

# 列出本地与某镜像名匹配的引用（repo:tag）
collect_local_refs() {
  local name="$1"
  docker images --format "{{.Repository}}:{{.Tag}}" 2>/dev/null \
    | grep -E "^(.*\/)?docker-${name}:" \
    | awk '!seen[$0]++'
}

# 获取某个本地引用的平台摘要（如 linux/amd64 或 linux/amd64,linux/arm64）
platforms_for_local_ref() {
  local ref="$1"
  local inspect_out plats

  inspect_out=$(docker buildx imagetools inspect "docker-daemon:${ref}" 2>/dev/null || true)
  plats=$(printf '%s\n' "$inspect_out" | awk '/Platform:/ {print $2}' | awk '!seen[$0]++' | paste -sd, -)
  if [[ -n "$plats" ]]; then
    echo "$plats"
    return 0
  fi

  docker image inspect "$ref" --format '{{.Os}}/{{.Architecture}}' 2>/dev/null || true
}

# 统计某个镜像名在本地已有架构
local_arch_summary_for_image() {
  local name="$1"
  local -a refs=()
  local -a plats=()
  local ref p

  while IFS= read -r ref; do
    [[ -n "$ref" ]] && refs+=("$ref")
  done < <(collect_local_refs "$name")

  if (( ${#refs[@]} == 0 )); then
    echo "(本地无镜像)"
    return 0
  fi

  for ref in "${refs[@]}"; do
    p=$(platforms_for_local_ref "$ref")
    [[ -n "$p" ]] && plats+=("$p")
  done

  if (( ${#plats[@]} == 0 )); then
    echo "(架构未知)"
    return 0
  fi

  printf '%s\n' "${plats[@]}" | tr ',' '\n' | awk 'NF && !seen[$0]++' | paste -sd, -
}

# 给定一组镜像引用，找出冗余的（可安全删除的）引用。
# 保留规则（按镜像名 / repo 分组）：
#   - 始终保留 tag 为 "latest" 的引用
#   - 在非 latest 引用中，保留构建时间最新的一条
#   - 其余视为冗余，输出到 stdout（每行一条）
filter_redundant_images() {
  # bash 3.2 兼容：用普通数组模拟分组（按镜像名去重后逐组处理）
  local -a names=()
  local n ref
  for ref in "$@"; do
    n="${ref%:*}"
    _in_array "$n" "${names[@]}" || names+=("$n")
  done

  for n in "${names[@]}"; do
    local -a refs=()
    for ref in "$@"; do
      [[ "${ref%:*}" == "$n" ]] && refs+=("$ref")
    done

    local -a nonlatest=()
    for ref in "${refs[@]}"; do
      [[ "${ref##*:}" == "latest" ]] && continue
      nonlatest+=("$ref")
    done

    if (( ${#nonlatest[@]} > 1 )); then
      local best_ref="" best_time=""
      for ref in "${nonlatest[@]}"; do
        local t
        t=$(docker image inspect "$ref" --format '{{.Created}}' 2>/dev/null || echo "")
        if [[ -z "$best_ref" ]] || [[ "$t" > "$best_time" ]]; then
          [[ -n "$best_ref" ]] && echo "$best_ref"
          best_ref="$ref" best_time="$t"
        else
          echo "$ref"
        fi
      done
    fi
  done
}

# 严格 SemVer 三段式校验（X.Y.Z）
validate_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# Git 短 SHA（非 git 环境返回空）
git_short_sha() {
  ( cd "$REPO_ROOT" && git rev-parse --short HEAD 2>/dev/null ) || true
}

# 工作目录是否含未提交修改（仅检查已跟踪文件）
git_is_dirty() {
  ( cd "$REPO_ROOT" && ! git diff-index --quiet HEAD -- 2>/dev/null )
}

# 循环提示输入合法 SemVer tag；结果写入全局 TAG_INPUT
# 用户输入 0 时返回 1（取消）；输入合法版本号时返回 0
prompt_semver_tag() {
  TAG_INPUT=""
  while :; do
    prompt "镜像 tag（X.Y.Z 格式，例 ${DEFAULT_TAG}；输入 0 返回）："
    read -r TAG_INPUT
    [[ "$TAG_INPUT" == "0" ]] && return 1
    if [[ -z "$TAG_INPUT" ]]; then
      err "tag 不能为空"
      continue
    fi
    if validate_semver "$TAG_INPUT"; then
      return 0
    fi
    err "tag 必须符合 SemVer 三段式 (X.Y.Z)，例如 1.2.3"
  done
}

# ============================================================
# 构建 / 推送核心
# ============================================================

build_image() {
  local name="$1" platforms="$2" tag="$3" push_flag="$4"
  local meta ctx df
  meta=$(image_meta "$name") || { err "未知镜像: $name"; return 1; }
  IFS='|' read -r ctx df <<<"$meta"
  ctx="${REPO_ROOT}/${ctx}"
  df="${REPO_ROOT}/${df}"

  if [[ ! -f "$df" ]]; then
    warn "跳过 ${name}：未找到 Dockerfile (${df})"
    return 0
  fi
  check_sensitive "$ctx" || { err "用户中止: $name"; return 1; }

  local registry_prefix=""
  if [[ -n "$REGISTRY" ]]; then
    registry_prefix="${REGISTRY%/}/"
  fi
  # SemVer 三段式 → 四档浮动 + 一档 git SHA 追溯
  #   X.Y.Z       完整版本（不可变）
  #   X.Y         minor 浮动（compose 默认 ${TAG:-1.0} 消费此 tag）
  #   X           major 浮动
  #   latest      整体最新
  #   X.Y.Z-<sha> commit 级追溯（dirty 工作区追加 -dirty 后缀）
  local base="${registry_prefix}docker-${name}"
  local full_tag="${base}:${tag}"
  local minor_tag="${base}:${tag%.*}"
  local major_tag="${base}:${tag%%.*}"
  local latest_tag="${base}:latest"

  local sha sha_tag=""
  sha=$(git_short_sha)
  if [[ -n "$sha" ]]; then
    local sha_suffix="$sha"
    git_is_dirty && sha_suffix="${sha}-dirty"
    sha_tag="${base}:${tag}-${sha_suffix}"
  fi

  info "构建 ${BOLD}${name}${RESET} → ${full_tag}  [${platforms}]"
  info "  附加 tag: ${minor_tag##*:}, ${major_tag##*:}, latest${sha_tag:+, ${sha_tag##*:}}"

  local args=(buildx build
    --platform "$platforms"
    --pull
    --progress=plain
    --build-arg "DEBIAN_MIRROR=$LINUX_MIRROR"
    --build-arg "APT_MIRROR=$APT_MIRROR"
    --build-arg "APK_MIRROR_ARG=$LINUX_MIRROR"
    --build-arg "DOCKER_MIRROR=$DOCKER_MIRROR"
    --build-arg "GOPROXY_ARG=$GOPROXY"
    -f "$df"
    -t "$full_tag" -t "$minor_tag" -t "$major_tag" -t "$latest_tag"
  )
  [[ -n "$sha_tag" ]] && args+=( -t "$sha_tag" )
  if [[ "$push_flag" == "push" ]]; then
    args+=(--push)
  else
    # 多平台构建无法直接 --load，单平台时可以
    if [[ "$platforms" != *","* ]]; then
      args+=(--load)
    else
      warn "多架构构建不会加载到本地 docker images（buildx 限制）。如需本地可用请选单一架构。"
    fi
  fi
  args+=("$ctx")

  docker "${args[@]}"
}

prune_buildx_cache() {
  ensure_buildx || return 1

  print_header
  echo "${BOLD}${CYAN}>> 清理 Buildx 构建缓存${RESET}"
  echo
  printf "  Builder: %s\n" "$BUILDX_BUILDER"
  echo "  说明: 该操作清理当前 builder 的本地构建缓存。"
  echo "       适用于多架构构建/推送后本地没有镜像标签，但仍想释放本地构建残留。"
  echo "       该操作不会删除远端仓库中的镜像。"
  echo
  prompt "确认清理 Buildx 缓存？(y/N):"
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]] || return 0

  docker buildx prune --builder "$BUILDX_BUILDER" -f
}

# ============================================================
# 菜单
# ============================================================

_ARCH_CHOICE=""

menu_image_select() {
  local title="$1"   # "打包" / "推送"
  print_header
  echo "${BOLD}${CYAN}>> ${title} / 选择镜像${RESET}"
  echo
  echo "  1. 全部"
  local idx=2
  local -a names=()
  for entry in "${IMAGES[@]}"; do
    IFS='|' read -r n _ _ <<<"$entry"
    names+=("$n")
    printf "  %d. %s\n" "$idx" "$n"
    idx=$((idx + 1))
  done
  echo "  0. 返回上级"
  echo
  prompt "请输入你的选项：（数字）"
  read -r c
  if [[ "$c" == "0" ]]; then return 1; fi
  if [[ "$c" == "1" ]]; then
    SELECTED_IMAGES=("${names[@]}")
    return 0
  fi
  if [[ "$c" =~ ^[0-9]+$ ]] && (( c >= 2 && c < idx )); then
    SELECTED_IMAGES=("${names[$((c - 2))]}")
    return 0
  fi
  err "无效选项"; sleep 1; return 2
}

action_build() {
  local platforms platform_desc
  platforms=$(host_platform) || {
    err "无法检测当前设备对应的镜像架构，请手动检查 uname -m。"
    pause_return
    return 1
  }
  platform_desc=$(platform_label "$platforms")

  print_header
  echo "${BOLD}${CYAN}>> 打包本地镜像（仅供本地使用）${RESET}"
  echo
  echo "  本功能仅构建当前设备环境可用的单一架构镜像。"
  printf "  当前设备目标架构: %s\n" "$platform_desc"
  printf "  目标平台参数    : %s\n" "$platforms"
  echo
  echo "  1. 确认"
  echo "  0. 取消（返回上级）"
  echo
  prompt "请选择："
  read -r c
  case "$c" in
    0) return 0 ;;
    1) ;;
    *) err "无效选项"; pause_return; return 1 ;;
  esac

  while :; do
    SELECTED_IMAGES=()
    menu_image_select "镜像打包"; local rc=$?
    [[ $rc -eq 1 ]] && return 0
    [[ $rc -eq 0 ]] && break
  done

  print_header
  echo "${BOLD}${CYAN}>> 打包本地镜像 / 输入版本号${RESET}"
  echo
  prompt_semver_tag || return 0
  local tag="$TAG_INPUT"

  ensure_buildx || { pause_return; return 1; }

  local sha
  sha=$(git_short_sha)
  echo
  info "目标平台: $platforms"
  info "Tag:      $tag"
  if [[ -n "$sha" ]]; then
    if git_is_dirty; then
      warn "Git: ${sha} (工作区有未提交修改，SHA tag 将带 -dirty 后缀)"
    else
      info "Git:      ${sha}"
    fi
  fi
  info "镜像列表: ${SELECTED_IMAGES[*]}"
  echo
  prompt "确认开始构建？(y/N):"
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]] || { warn "已取消"; pause_return; return 0; }

  local fail=0
  for name in "${SELECTED_IMAGES[@]}"; do
    if ! build_image "$name" "$platforms" "$tag" "load"; then
      err "构建失败: $name"
      fail=$((fail + 1))
    else
      ok "完成: $name"
    fi
  done
  echo
  if (( fail == 0 )); then ok "全部构建完成"; else err "$fail 个镜像构建失败"; fi
  pause_return
}

action_push() {
  print_header
  echo "${BOLD}${CYAN}>> 推送远程镜像${RESET}"
  echo
  echo "  推送远程镜像将重建镜像并直接推送至指定仓库。"
  echo "  该流程不会使用本地已构建镜像作为推送源。"
  echo
  echo "  1. 确认"
  echo "  0. 返回上级"
  echo
  prompt "请选择："
  read -r c
  case "$c" in
    0) return 0 ;;
    1) ;;
    *) err "无效选项"; pause_return; return 1 ;;
  esac

  print_header
  echo "${BOLD}${CYAN}>> 推送远程镜像 / 仓库配置 & 登录${RESET}"
  echo
  printf "  当前仓库地址: %s\n" "${REGISTRY:-${DIM}(未设置)${RESET}}"
  echo
  echo "  1. 使用当前仓库地址并登录"
  echo "  2. 修改仓库地址并登录"
  echo "  0. 返回上级"
  echo
  prompt "请选择："
  read -r reg_choice

  if [[ "$reg_choice" == "0" ]]; then
    return 0
  elif [[ "$reg_choice" == "2" ]]; then
    printf "  ${DIM}格式: <registry-host>/<namespace>，例如:${RESET}\n"
    printf "  ${DIM}  crpi-xxxxx.cn-guangzhou.personal.cr.aliyuncs.com/laboflow${RESET}\n"
    echo
    prompt "请输入私有仓库地址："
    read -r reg
    [[ -z "$reg" ]] && { warn "已取消"; pause_return; return 0; }
    REGISTRY="$reg"
  elif [[ "$reg_choice" != "1" ]]; then
    err "无效选项"; pause_return; return 1
  fi

  [[ -z "$REGISTRY" ]] && { err "仓库地址未设置"; pause_return; return 1; }

  info "执行: docker login ${REGISTRY%%/*}"
  echo
  docker login "${REGISTRY%%/*}" || { err "登录失败"; pause_return; return 1; }
  echo
  ok "登录成功"

  while :; do
    menu_push_arch_select; local rc=$?
    [[ $rc -eq 1 ]] && return 0
    [[ $rc -eq 0 ]] && break
  done
  local platforms; platforms=$(platforms_for_choice "$_ARCH_CHOICE")

  while :; do
    SELECTED_IMAGES=()
    menu_image_select "镜像推送"; local rc=$?
    [[ $rc -eq 1 ]] && return 0
    [[ $rc -eq 0 ]] && break
  done

  prompt_semver_tag || return 0
  local tag="$TAG_INPUT"

  ensure_buildx || { pause_return; return 1; }

  local sha
  sha=$(git_short_sha)
  echo
  info "仓库: $REGISTRY"
  info "平台: $platforms"
  info "Tag:  $tag"
  if [[ -n "$sha" ]]; then
    if git_is_dirty; then
      warn "Git: ${sha} (工作区有未提交修改 — 不建议作为正式发布版本推送)"
    else
      info "Git:  ${sha}"
    fi
  fi
  info "镜像: ${SELECTED_IMAGES[*]}"
  info "模式: 重新构建并直接推送"
  echo
  prompt "确认开始推送？(y/N):"
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]] || { warn "已取消"; pause_return; return 0; }

  local fail=0
  for name in "${SELECTED_IMAGES[@]}"; do
    if ! build_image "$name" "$platforms" "$tag" "push"; then
      err "推送失败: $name"
      fail=$((fail + 1))
    else
      ok "已推送: $name"
    fi
  done
  echo
  (( fail == 0 )) && ok "全部推送完成" || err "$fail 个镜像失败"
  pause_return
}

action_delete() {
  while :; do
    print_header
    echo "${BOLD}${CYAN}>> 删除镜像 / 清理缓存${RESET}"
    echo
    echo "  ${DIM}提示：删除时会智能保留 latest 标签和每个镜像名下最新构建的非 latest 镜像${RESET}"
    echo
    echo "  1. 删除全部（清除所有 LaboFlow 本地镜像）"
    local idx=2
    local cache_choice
    local -a names=()
    for entry in "${IMAGES[@]}"; do
      IFS='|' read -r n _ _ <<<"$entry"
      names+=("$n")
      printf "  %d. 删除 %s\n" "$idx" "$n"
      idx=$((idx + 1))
    done
    cache_choice=$idx
    printf "  %d. 清理 Buildx 构建缓存（适用于多架构构建/推送后的本地残留）\n" "$cache_choice"
    echo "  0. 返回上级"
    echo
    prompt "请输入你的选项：（数字）"
    read -r c

    if [[ "$c" == "0" ]]; then return 0; fi

    if [[ "$c" == "$cache_choice" ]]; then
      if prune_buildx_cache; then
        ok "Buildx 缓存清理完成"
      else
        err "Buildx 缓存清理失败"
      fi
      pause_return
      continue
    fi

    local to_delete=()
    if [[ "$c" == "1" ]]; then
      to_delete=("${names[@]}")
    elif [[ "$c" =~ ^[0-9]+$ ]] && (( c >= 2 && c < idx )); then
      to_delete=("${names[$((c - 2))]}")
    else
      err "无效选项"; sleep 1; continue
    fi

    # 列出将要删除的镜像
    echo
    local img_ids=()
    for name in "${to_delete[@]}"; do
      while IFS= read -r line; do
        [[ -n "$line" ]] && img_ids+=("$line")
      done < <(docker images --format "{{.Repository}}:{{.Tag}}" 2>/dev/null \
        | grep -E "^(.*\/)?docker-${name}:")
      # 也匹配无 registry 前缀的情况
      while IFS= read -r line; do
        [[ -n "$line" ]] && img_ids+=("$line")
      done < <(docker images --format "{{.Repository}}:{{.Tag}}" 2>/dev/null \
        | grep -E "^docker-${name}:")
    done

    # 去重 (bash 3.2 兼容，不使用关联数组)
    local -a unique_ids=()
    local id needle found
    for id in "${img_ids[@]}"; do
      found=0
      for needle in "${unique_ids[@]}"; do
        [[ "$needle" == "$id" ]] && { found=1; break; }
      done
      [[ $found -eq 0 ]] && unique_ids+=("$id")
    done

    if (( ${#unique_ids[@]} == 0 )); then
      warn "本地未找到匹配的镜像"
      warn "如果这些镜像是通过多架构构建/远程推送生成的，本地通常不会有可删除的 docker images 标签。"
      warn "这种情况下可以改为清理 Buildx 构建缓存，以释放本地构建残留。"
      echo
      prompt "是否立即清理 Buildx 构建缓存？(y/N):"
      read -r ans
      if [[ "$ans" =~ ^[Yy]$ ]]; then
        if prune_buildx_cache; then
          ok "Buildx 缓存清理完成"
        else
          err "Buildx 缓存清理失败"
        fi
      fi
      pause_return; continue
    fi

    # ---- 智能过滤：保留 latest + 每个镜像名下最新构建的非 latest 镜像 ----
    local -a redundant_ids=()
    while IFS= read -r line; do
      [[ -n "$line" ]] && redundant_ids+=("$line")
    done < <(filter_redundant_images "${unique_ids[@]}")

    if (( ${#redundant_ids[@]} == 0 )); then
      ok "没有检测到多余的镜像（所有镜像均为 latest 或最新版本，已全部保留）"
      pause_return; continue
    fi

    echo
    info "保留策略：latest 标签 + 每个镜像名下构建时间最新的非 latest 镜像"
    echo
    printf "  ${GREEN}保留${RESET}：\n"
    for id in "${unique_ids[@]}"; do
      if ! _in_array "$id" "${redundant_ids[@]}"; then
        local c_time
        c_time=$(docker image inspect "$id" --format '{{.Created}}' 2>/dev/null || echo "未知")
        printf "    ${GREEN}✓${RESET} %s  ${DIM}(%s)${RESET}\n" "$id" "${c_time%%.*}"
      fi
    done
    echo
    printf "  ${RED}删除${RESET}：\n"
    for id in "${redundant_ids[@]}"; do
      local c_time
      c_time=$(docker image inspect "$id" --format '{{.Created}}' 2>/dev/null || echo "未知")
      printf "    ${RED}-${RESET} %s  ${DIM}(%s)${RESET}\n" "$id" "${c_time%%.*}"
    done

    echo
    prompt "确认删除以上 ${#redundant_ids[@]} 个多余镜像？(y/N):"
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]] || { warn "已取消"; pause_return; continue; }

    local fail=0
    for id in "${redundant_ids[@]}"; do
      if docker rmi "$id" >/dev/null 2>&1; then
        ok "已删除: $id"
      else
        err "删除失败: $id（可能正在使用中）"
        fail=$((fail + 1))
      fi
    done
    echo
    (( fail == 0 )) && ok "删除完成" || err "$fail 个镜像删除失败"
    pause_return
  done
}

action_image_list() {
  print_header
  echo "${BOLD}${CYAN}>> 镜像清单${RESET}"
  echo
  for entry in "${IMAGES[@]}"; do
    IFS='|' read -r n ctx df <<<"$entry"
    local arch_summary
    arch_summary=$(local_arch_summary_for_image "$n")
    if [[ -f "${REPO_ROOT}/${df}" ]]; then
      printf "    ${GREEN}●${RESET} %-20s %s\n" "$n" "$df"
    else
      printf "    ${RED}○${RESET} %-20s %s ${DIM}(Dockerfile 缺失)${RESET}\n" "$n" "$df"
    fi
    printf "      ${GRAY}本地架构: %s${RESET}\n" "$arch_summary"
  done
  pause_return
}

action_config() {
  while :; do
    print_header
    echo "${BOLD}${CYAN}>> 功能配置${RESET}"
    echo
    echo "  当前配置"
    printf "  REGISTRY      : %s\n" "${REGISTRY:-${DIM}(未设置)${RESET}}"
    printf "  DEFAULT_TAG   : %s\n" "$DEFAULT_TAG"
    printf "  BUILDX_BUILDER: %s\n" "$BUILDX_BUILDER"
    printf "  REPO_ROOT     : %s\n" "$REPO_ROOT"
    printf "  Linux 源地址  : %s (%s)\n" "$LINUX_MIRROR" "$(linux_mirror_label "$LINUX_MIRROR")"
    printf "  Docker 镜像源 : %s (%s)\n" "$DOCKER_MIRROR" "$(docker_mirror_label "$DOCKER_MIRROR")"
    echo
    echo "  1. 修改 Linux 源地址"
    echo "  2. 修改 Docker 镜像源"
    echo "  0. 返回上级"
    echo
    prompt "请选择："
    read -r c
    case "$c" in
      0) return 0 ;;
      2)
        print_header
        echo "${BOLD}${CYAN}>> 功能配置 / 修改 Docker 镜像源${RESET}"
        echo
        echo "  1. 1ms 镜像加速（docker.1ms.run）"
        echo "  2. DaoCloud 镜像加速（docker.m.daocloud.io）"
        echo "  3. Docker Hub 直连（docker.io，无加速）"
        echo "  0. 返回上级"
        echo
        prompt "请选择："
        read -r mirror_choice
        case "$mirror_choice" in
          0) ;;
          1) DOCKER_MIRROR="docker.1ms.run"; ok "已切换为 1ms 镜像加速"; pause_return ;;
          2) DOCKER_MIRROR="docker.m.daocloud.io"; ok "已切换为 DaoCloud 镜像加速"; pause_return ;;
          3) DOCKER_MIRROR="docker.io"; ok "已切换为 Docker Hub 直连"; pause_return ;;
          *) err "无效选项"; pause_return ;;
        esac
        ;;
      1)
        print_header
        echo "${BOLD}${CYAN}>> 功能配置 / 修改 Linux 源地址${RESET}"
        echo
        echo "  1. Debian 官方源"
        echo "  2. 清华 TUNA 源"
        echo "  3. 中科大 USTC 源"
        echo "  0. 返回上级"
        echo
        prompt "请选择："
        read -r mirror_choice
        case "$mirror_choice" in
          0) ;;
          1) LINUX_MIRROR="deb.debian.org"; ok "已切换为 Debian 官方源"; pause_return ;;
          2) LINUX_MIRROR="mirrors.tuna.tsinghua.edu.cn"; ok "已切换为清华 TUNA 源"; pause_return ;;
          3) LINUX_MIRROR="mirrors.ustc.edu.cn"; ok "已切换为中科大 USTC 源"; pause_return ;;
          *) err "无效选项"; pause_return ;;
        esac
        ;;
      *) err "无效选项"; sleep 1 ;;
    esac
  done
}

main_menu() {
  while :; do
    print_header
    echo "${BOLD}${CYAN}>> 主菜单${RESET}"
    echo
    echo "  1. 打包本地镜像"
    echo "  2. 推送远程镜像"
    echo "  3. 删除镜像 / 清理缓存"
    echo "  4. 镜像清单"
    echo "  5. 功能配置"
    echo "  0. 退出"
    echo
    prompt "请输入你的选项：（数字）"
    read -r c
    case "$c" in
      1) action_build ;;
      2) action_push ;;
      3) action_delete ;;
      4) action_image_list ;;
      5) action_config ;;
      0) ok "再见 ✨"; exit 0 ;;
      *) err "无效选项"; sleep 1 ;;
    esac
  done
}

# ============================================================
# 入口
# ============================================================
main_menu
