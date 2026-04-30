#!/usr/bin/env bash
# LaboFlow Docker 镜像管理脚本
# Powered by Lance

set -o pipefail

# ============================================================
# 配置区（按需修改）
# ============================================================

# 私有镜像仓库地址，留空则在推送前提示输入。
# 示例: crpi-xxxxx.cn-guangzhou.personal.cr.aliyuncs.com/laboflow
REGISTRY=""

# 默认镜像 tag（可在菜单里覆盖）
DEFAULT_TAG="latest"

# 镜像清单：name|context_dir|dockerfile（相对仓库根目录）
# 新增镜像在此追加一行即可，菜单会自动出现。
IMAGES=(
  "clawith-backend|Clawith/backend|Clawith/backend/Dockerfile"
  "clawith-frontend|Clawith/frontend|Clawith/frontend/Dockerfile"
  "clawith-bridge|Clawith/bridge|Clawith/bridge/Dockerfile"
  "aippt|aippt|aippt/Dockerfile"
  "nginx|nginx|nginx/Dockerfile"
  "ragflow|ragflow|ragflow/Dockerfile.laboflow"
)

# 敏感文件模式：构建上下文中若存在且未被 .dockerignore 排除则拒绝构建
SENSITIVE_PATTERNS=(
  ".env" ".env.local" ".env.production" ".env.development"
  "*.key" "*.pem" "ss-nodes.json"
  "agent_data" "node_modules"
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
  local sub="V26.4.29  Powered by Lance"
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
    while IFS= read -r -d '' f; do
      local rel="${f#$ctx/}"
      if [[ -f "$ignore_file" ]] && grep -qE "(^|/)${pat//./\\.}(\$|/)" "$ignore_file"; then
        continue
      fi
      # 简易匹配：若 .dockerignore 含通配同名也认为安全
      if [[ -f "$ignore_file" ]] && grep -qFx "$pat" "$ignore_file"; then
        continue
      fi
      found+=("$rel")
    done < <(find "$ctx" -maxdepth 4 -name "$pat" -print0 2>/dev/null)
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
  local full_tag="${registry_prefix}docker-${name}:${tag}"
  local latest_tag="${registry_prefix}docker-${name}:latest"

  info "构建 ${BOLD}${name}${RESET} → ${full_tag}  [${platforms}]"

  local args=(buildx build
    --platform "$platforms"
    --progress=plain
    -f "$df"
    -t "$full_tag" -t "$latest_tag"
  )
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

# ============================================================
# 菜单
# ============================================================

# 结果存入全局 _ARCH_CHOICE，避免 $() 子 Shell 吞掉 read
_ARCH_CHOICE=""
menu_arch_select() {
  print_header
  echo "${BOLD}${CYAN}>> 镜像打包 / 选择架构${RESET}"
  echo
  echo "  1. 通用架构（linux/amd64 + linux/arm64）"
  echo "  2. Linux-AMD64（x86_64，Linux/Windows）"
  echo "  3. ARM64（Apple Silicon / ARM Linux）"
  echo "  0. 返回上级"
  echo
  prompt "请输入你的选项：（数字）"
  read -r c
  case "$c" in
    0) return 1 ;;
    1|2|3) _ARCH_CHOICE="$c"; return 0 ;;
    *) err "无效选项"; sleep 1; return 2 ;;
  esac
}

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
  while :; do
    menu_arch_select; local rc=$?
    [[ $rc -eq 1 ]] && return 0
    [[ $rc -eq 0 ]] && break
  done
  local platforms; platforms=$(platforms_for_choice "$_ARCH_CHOICE")

  while :; do
    SELECTED_IMAGES=()
    menu_image_select "镜像打包"; local rc=$?
    [[ $rc -eq 1 ]] && return 0
    [[ $rc -eq 0 ]] && break
  done

  print_header
  prompt "镜像 tag（默认 ${DEFAULT_TAG}）："
  read -r tag
  tag="${tag:-$DEFAULT_TAG}"

  ensure_buildx || { pause_return; return 1; }

  echo
  info "目标平台: $platforms"
  info "Tag:      $tag"
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
  if [[ -z "$REGISTRY" ]]; then
    print_header
    warn "尚未配置 REGISTRY 仓库地址。"
    prompt "请输入私有仓库地址（留空取消）："
    read -r reg
    [[ -z "$reg" ]] && { warn "已取消"; pause_return; return 0; }
    REGISTRY="$reg"
  fi

  while :; do
    SELECTED_IMAGES=()
    menu_image_select "镜像推送"; local rc=$?
    [[ $rc -eq 1 ]] && return 0
    [[ $rc -eq 0 ]] && break
  done

  print_header
  echo "  1. 通用架构（linux/amd64 + linux/arm64）"
  echo "  2. Linux-AMD64"
  echo "  3. ARM64"
  echo "  0. 返回"
  prompt "推送架构选择："
  read -r ac
  [[ "$ac" == "0" ]] && return 0
  local platforms; platforms=$(platforms_for_choice "$ac") || { err "无效"; pause_return; return 1; }

  prompt "镜像 tag（默认 ${DEFAULT_TAG}）："
  read -r tag
  tag="${tag:-$DEFAULT_TAG}"

  ensure_buildx || { pause_return; return 1; }

  echo
  info "仓库: $REGISTRY"
  info "平台: $platforms"
  info "Tag:  $tag"
  info "镜像: ${SELECTED_IMAGES[*]}"
  prompt "确认推送？该操作会上传到远端仓库 (y/N):"
  read -r ans
  [[ "$ans" =~ ^[Yy]$ ]] || { warn "已取消"; pause_return; return 0; }

  if ! docker info 2>/dev/null | grep -q "Username"; then
    warn "看起来未登录 Docker 仓库，尝试 docker login..."
    docker login "${REGISTRY%%/*}" || { err "登录失败"; pause_return; return 1; }
  fi

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
    echo "${BOLD}${CYAN}>> 删除镜像${RESET}"
    echo
    echo "  1. 删除全部（清除所有 LaboFlow 本地镜像）"
    local idx=2
    local -a names=()
    for entry in "${IMAGES[@]}"; do
      IFS='|' read -r n _ _ <<<"$entry"
      names+=("$n")
      printf "  %d. 删除 %s\n" "$idx" "$n"
      idx=$((idx + 1))
    done
    echo "  0. 返回上级"
    echo
    prompt "请输入你的选项：（数字）"
    read -r c

    if [[ "$c" == "0" ]]; then return 0; fi

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

    # 去重
    local -a unique_ids=()
    declare -A seen=()
    for id in "${img_ids[@]}"; do
      if [[ -z "${seen[$id]+_}" ]]; then
        seen[$id]=1
        unique_ids+=("$id")
      fi
    done

    if (( ${#unique_ids[@]} == 0 )); then
      warn "本地未找到匹配的镜像"
      pause_return; continue
    fi

    info "以下本地镜像将被删除："
    for id in "${unique_ids[@]}"; do
      printf "    ${RED}-${RESET} %s\n" "$id"
    done
    echo
    prompt "确认删除？此操作不可恢复 (y/N):"
    read -r ans
    [[ "$ans" =~ ^[Yy]$ ]] || { warn "已取消"; pause_return; continue; }

    local fail=0
    for id in "${unique_ids[@]}"; do
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

action_settings() {
  print_header
  echo "${BOLD}${CYAN}>> 当前配置${RESET}"
  echo
  printf "  REGISTRY      : %s\n" "${REGISTRY:-${DIM}(未设置)${RESET}}"
  printf "  DEFAULT_TAG   : %s\n" "$DEFAULT_TAG"
  printf "  BUILDX_BUILDER: %s\n" "$BUILDX_BUILDER"
  printf "  REPO_ROOT     : %s\n" "$REPO_ROOT"
  echo
  echo "  镜像清单："
  for entry in "${IMAGES[@]}"; do
    IFS='|' read -r n ctx df <<<"$entry"
    if [[ -f "${REPO_ROOT}/${df}" ]]; then
      printf "    ${GREEN}●${RESET} %-20s %s\n" "$n" "$df"
    else
      printf "    ${RED}○${RESET} %-20s %s ${DIM}(Dockerfile 缺失)${RESET}\n" "$n" "$df"
    fi
  done
  pause_return
}

main_menu() {
  while :; do
    print_header
    echo "${BOLD}${CYAN}>> 主菜单${RESET}"
    echo
    echo "  1. 镜像打包"
    echo "  2. 镜像推送"
    echo "  3. 删除镜像"
    echo "  4. 查看配置 / 镜像清单"
    echo "  0. 退出"
    echo
    prompt "请输入你的选项：（数字）"
    read -r c
    case "$c" in
      1) action_build ;;
      2) action_push ;;
      3) action_delete ;;
      4) action_settings ;;
      0) ok "再见 ✨"; exit 0 ;;
      *) err "无效选项"; sleep 1 ;;
    esac
  done
}

# ============================================================
# 入口
# ============================================================
main_menu
