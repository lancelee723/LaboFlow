# LightRAG WebUI Notion Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade LightRAG WebUI to Notion design language: full token system, per-feature WorkspaceShell sidebars, dark-mode removal, dead-code deletion, Inter font.

**Architecture:** 4-phase incremental approach — Phase 1 lays the token/font/cleanup foundation; Phase 2 introduces WorkspaceShell container; Phase 3 migrates each feature to use the shell with real sidebar content; Phase 4 polishes dialogs and i18n.

**Tech Stack:** React 19, Vite, Tailwind CSS v4, Zustand, shadcn/ui, @fontsource-variable/inter, bun (test runner)

**Working directory:** `/Users/lance/LaboFlow/LightRAG/lightrag_webui`

---

## Phase 1 — Foundation

### Task 1: Install Inter Variable font package

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

```bash
cd /Users/lance/LaboFlow/LightRAG/lightrag_webui
bun add @fontsource-variable/inter
```

Expected output: Package added to `package.json` dependencies and `bun.lock` updated.

- [ ] **Step 2: Verify installation**

```bash
ls node_modules/@fontsource-variable/inter/index.css
```

Expected: File exists.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "feat: add @fontsource-variable/inter for cross-platform font"
```

---

### Task 2: Update index.css — tokens, dark mode removal, Inter font

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Replace the entire `:root` block and remove `.dark` blocks**

The file currently has `:root { ... }` with basic tokens, two `.dark { ... }` blocks, and `@theme inline { ... }`. Make the following changes:

1. After the existing `:root` closing `}`, **add** these new tokens inside `:root` (insert before the `}` on line 46):

```css
  /* status semantic */
  --status-success-bg: #dcfce7; --status-success-fg: #166534;
  --status-info-bg:    #dbeafe; --status-info-fg:    #1e40af;
  --status-warning-bg: #fef3c7; --status-warning-fg: #92400e;
  --status-danger-bg:  #fee2e2; --status-danger-fg:  #991b1b;
  --status-neutral-bg: #f3e8ff; --status-neutral-fg: #6b21a8;

  /* accent semantic */
  --accent-teal:   #2a9d99;
  --accent-orange: #dd5b00;
  --accent-pink:   #ff64c8;
  --accent-purple: #391c57;

  /* workspace sidebar internals */
  --sidebar-section-label: #8a847e;
  --sidebar-divider:       rgba(0, 0, 0, 0.06);

  /* deep shadow for modals */
  --shadow-deep: rgba(0,0,0,0.01) 0px 1px 3px, rgba(0,0,0,0.02) 0px 3px 7px,
                 rgba(0,0,0,0.02) 0px 7px 15px, rgba(0,0,0,0.04) 0px 14px 28px,
                 rgba(0,0,0,0.05) 0px 23px 52px;
```

2. **Remove** the first `.dark { ... }` block (lines 48-81).

3. In `@theme inline`, add after `--shadow-card: var(--shadow-card);`:

```css
  --shadow-deep: var(--shadow-deep);
  --color-status-success-bg: var(--status-success-bg);
  --color-status-success-fg: var(--status-success-fg);
  --color-status-info-bg:    var(--status-info-bg);
  --color-status-info-fg:    var(--status-info-fg);
  --color-status-warning-bg: var(--status-warning-bg);
  --color-status-warning-fg: var(--status-warning-fg);
  --color-status-danger-bg:  var(--status-danger-bg);
  --color-status-danger-fg:  var(--status-danger-fg);
  --color-status-neutral-bg: var(--status-neutral-bg);
  --color-status-neutral-fg: var(--status-neutral-fg);
  --color-sidebar-section-label: var(--sidebar-section-label);
  --color-sidebar-divider:       var(--sidebar-divider);
```

4. In `@layer base > body`, replace the `font-family` line:

```css
    font-family: 'Inter Variable', 'Inter', -apple-system, system-ui,
                 'Segoe UI', Helvetica, Arial, sans-serif;
```

5. **Remove** the second `.dark { ... }` block (the scrollbar one, lines 167-175).

6. **Remove** the `.dark .shell-sidebar-scroll` block (lines 254-258) and the `.dark .katex .katex-error` block (lines 230-234).

- [ ] **Step 2: Verify no `.dark` remains (except katex upstream lib)**

```bash
grep -n "\.dark" src/index.css
```

Expected: 0 lines (or only unrelated katex upstream mentions — none expected).

- [ ] **Step 3: Verify build still passes**

```bash
bun run build 2>&1 | tail -5
```

Expected: Successful build output.

- [ ] **Step 4: Commit**

```bash
git add src/index.css
git commit -m "feat(tokens): add status/accent/shadow-deep tokens, remove dark mode, switch to Inter Variable"
```

---

### Task 3: Rewrite tailwind.config.js to Tailwind v4 idiomatic

**Files:**
- Modify: `tailwind.config.js`

- [ ] **Step 1: Rewrite the file**

The current file has `darkMode: ['class']` and `colors.x: 'hsl(var(--x))'` wrappers that conflict with Tailwind v4's `@theme inline` approach. Replace the file entirely:

```js
import tailwindcssAnimate from 'tailwindcss-animate'
import typography from '@tailwindcss/typography'

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      typography: {
        DEFAULT: {
          css: {
            maxWidth: '100%',
            color: 'var(--tw-prose-body)',
            '[class~="lead"]': { color: 'var(--tw-prose-lead)' },
            a: { color: 'var(--tw-prose-links)', textDecoration: 'underline', fontWeight: '500' },
            strong: { color: 'var(--tw-prose-bold)', fontWeight: '600' },
            'ol[type="A"]':    { listStyleType: 'upper-alpha' },
            'ol[type="a"]':    { listStyleType: 'lower-alpha' },
            'ol[type="A" s]':  { listStyleType: 'upper-alpha' },
            'ol[type="a" s]':  { listStyleType: 'lower-alpha' },
            'ol[type="I"]':    { listStyleType: 'upper-roman' },
            'ol[type="i"]':    { listStyleType: 'lower-roman' },
            'ol[type="I" s]':  { listStyleType: 'upper-roman' },
            'ol[type="i" s]':  { listStyleType: 'lower-roman' },
            'ol[type="1"]':    { listStyleType: 'decimal' },
            'ol > li': { position: 'relative', paddingLeft: '1.75em' },
            'ol > li::before': { content: 'counter(list-item, var(--list-counter-style, decimal)) "."', position: 'absolute', fontWeight: '400', color: 'var(--tw-prose-counters)', left: '0' },
            'ul > li': { position: 'relative', paddingLeft: '1.75em' },
            'ul > li::before': { content: '""', position: 'absolute', backgroundColor: 'var(--tw-prose-bullets)', borderRadius: '50%', width: '0.375em', height: '0.375em', top: 'calc(0.875em - 0.1875em)', left: '0.25em' },
            hr: { borderColor: 'var(--tw-prose-hr)', borderTopWidth: 1, marginTop: '3em', marginBottom: '3em' },
            blockquote: { fontWeight: '500', fontStyle: 'italic', color: 'var(--tw-prose-quotes)', borderLeftWidth: '0.25rem', borderLeftColor: 'var(--tw-prose-quote-borders)', quotes: '"\\201C""\\201D""\\2018""\\2019"', marginTop: '1.6em', marginBottom: '1.6em', paddingLeft: '1em' },
            h1: { color: 'var(--tw-prose-headings)', fontWeight: '800', fontSize: '2.25em', marginTop: '0', marginBottom: '0.8888889em', lineHeight: '1.1111111' },
            h2: { color: 'var(--tw-prose-headings)', fontWeight: '700', fontSize: '1.5em', marginTop: '2em', marginBottom: '1em', lineHeight: '1.3333333' },
            h3: { color: 'var(--tw-prose-headings)', fontWeight: '600', fontSize: '1.25em', marginTop: '1.6em', marginBottom: '0.6em', lineHeight: '1.6' },
            h4: { color: 'var(--tw-prose-headings)', fontWeight: '600', marginTop: '1.5em', marginBottom: '0.5em', lineHeight: '1.5' },
            'figure > *': { margin: '0' },
            figcaption: { color: 'var(--tw-prose-captions)', fontSize: '0.875em', lineHeight: '1.4285714', marginTop: '0.8571429em' },
            code: { color: 'var(--tw-prose-code)', fontWeight: '600', fontSize: '0.875em' },
            'code::before': { content: '""' },
            'code::after':  { content: '""' },
            'a code': { color: 'var(--tw-prose-links)' },
            'h1 code': { color: 'inherit' },
            'h2 code': { color: 'inherit', fontSize: '0.875em' },
            'h3 code': { color: 'inherit', fontSize: '0.9em' },
            'h4 code': { color: 'inherit' },
            'blockquote code': { color: 'inherit' },
            'thead': { color: 'var(--tw-prose-headings)', fontWeight: '600', borderBottomWidth: '1px', borderBottomColor: 'var(--tw-prose-th-borders)' },
            'thead th': { verticalAlign: 'bottom', paddingRight: '0.5714286em', paddingBottom: '0.5714286em', paddingLeft: '0.5714286em' },
            'tbody tr': { borderBottomWidth: '1px', borderBottomColor: 'var(--tw-prose-td-borders)' },
            'tbody tr:last-child': { borderBottomWidth: '0' },
            'tbody td': { verticalAlign: 'baseline', paddingTop: '0.5714286em', paddingRight: '0.5714286em', paddingBottom: '0.5714286em', paddingLeft: '0.5714286em' },
            p: { marginTop: '1.25em', marginBottom: '1.25em' },
          },
        },
      },
    },
  },
  plugins: [tailwindcssAnimate, typography],
}
```

- [ ] **Step 2: Verify build**

```bash
bun run build 2>&1 | tail -5
```

Expected: Successful build, no errors about unknown theme values.

- [ ] **Step 3: Commit**

```bash
git add tailwind.config.js
git commit -m "refactor(tailwind): remove v3 hsl() wrappers and darkMode, keep plugins"
```

---

### Task 4: Update main.tsx — import Inter font

**Files:**
- Modify: `src/main.tsx`

- [ ] **Step 1: Add font import to top of main.tsx**

At the very top of `src/main.tsx`, before all other imports, add:

```tsx
import '@fontsource-variable/inter'
```

- [ ] **Step 2: Verify build**

```bash
bun run build 2>&1 | grep -E "(error|warning|Built)" | head -10
```

Expected: No errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/main.tsx
git commit -m "feat(font): load Inter Variable from @fontsource-variable/inter"
```

---

### Task 5: Create StatusBadge component

**Files:**
- Create: `src/components/ui/StatusBadge.tsx`

- [ ] **Step 1: Create the file**

```tsx
import { cn } from '@/lib/utils'
import { type ReactNode } from 'react'

export type StatusVariant = 'success' | 'info' | 'warning' | 'danger' | 'neutral'

interface StatusBadgeProps {
  variant: StatusVariant
  children: ReactNode
  className?: string
}

const variantClasses: Record<StatusVariant, string> = {
  success: 'bg-[var(--status-success-bg)] text-[var(--status-success-fg)]',
  info:    'bg-[var(--status-info-bg)] text-[var(--status-info-fg)]',
  warning: 'bg-[var(--status-warning-bg)] text-[var(--status-warning-fg)]',
  danger:  'bg-[var(--status-danger-bg)] text-[var(--status-danger-fg)]',
  neutral: 'bg-[var(--status-neutral-bg)] text-[var(--status-neutral-fg)]',
}

export default function StatusBadge({ variant, children, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold tracking-[0.125px]',
        variantClasses[variant],
        className
      )}
    >
      {children}
    </span>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Create NotionCard component** — `src/components/ui/NotionCard.tsx`

```tsx
import { cn } from '@/lib/utils'
import { type HTMLAttributes } from 'react'

interface NotionCardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'raised' | 'flat'
}

export default function NotionCard({
  variant = 'raised',
  className,
  children,
  ...props
}: NotionCardProps) {
  return (
    <div
      className={cn(
        'rounded-[12px] border border-border bg-card',
        variant === 'raised' && 'shadow-[var(--shadow-card)]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/StatusBadge.tsx src/components/ui/NotionCard.tsx
git commit -m "feat(ui): add StatusBadge and NotionCard components"
```

---

### Task 6: Update Button.tsx — press feedback and hover color

**Files:**
- Modify: `src/components/ui/Button.tsx`

- [ ] **Step 1: Update the base classes and default variant**

In `src/components/ui/Button.tsx`, update the `cva` call base string and the `default` variant:

Current base:
```
'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0'
```

New base (add `active:scale-[0.98] transition-transform`):
```
'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0'
```

Current default variant:
```
default: 'bg-primary text-primary-foreground hover:bg-primary/90',
```

New default variant:
```
default: 'bg-primary text-primary-foreground hover:bg-[#005bab]',
```

- [ ] **Step 2: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/Button.tsx
git commit -m "feat(ui): add press scale feedback and explicit hover blue to Button"
```

---

### Task 7: Delete dead files and remove ThemeToggle references

**Files:**
- Delete: `src/features/SiteHeader.tsx`
- Delete: `src/features/ApiSite.tsx`
- Delete: `src/components/ThemeProvider.tsx`
- Delete: `src/components/ThemeToggle.tsx`
- Modify: `src/components/AppSettings.tsx` (remove theme UI)
- Modify: `src/stores/settings.ts` (remove theme field)
- Modify: `src/main.tsx` or `src/AppRouter.tsx` (remove ThemeProvider wrapper)

- [ ] **Step 1: Find all ThemeProvider and ThemeToggle imports**

```bash
grep -rn "ThemeProvider\|ThemeToggle\|SiteHeader\|ApiSite" src/ --include="*.tsx" --include="*.ts"
```

Note all files that import these — they need to be cleaned up.

- [ ] **Step 2: Remove ThemeProvider from its wrapper location**

Find where ThemeProvider wraps the app (likely `src/main.tsx` or `src/AppRouter.tsx`). Remove the import and wrapper element. Example: if `src/main.tsx` has:
```tsx
import { ThemeProvider } from '@/components/ThemeProvider'
...
<ThemeProvider ...>
  <App />
</ThemeProvider>
```
Remove the wrapper, keeping just `<App />` (or `<RouterProvider ... />`).

- [ ] **Step 3: Update AppSettings.tsx — remove theme selection**

Read the full file first, then remove the `theme` / `setTheme` state variables and any JSX that renders theme selection UI (Select with light/dark/system options). Keep the language selection UI intact.

The file should still show the language toggle. Remove these lines:
```tsx
const theme = useSettingsStore.use.theme()
const setTheme = useSettingsStore.use.setTheme()
const handleThemeChange = useCallback(...)
```
And remove the JSX section that uses them.

- [ ] **Step 4: Remove theme field from settings store**

In `src/stores/settings.ts`:

Remove from interface `SettingsState`:
```ts
  theme: Theme
  setTheme: (theme: Theme) => void
```

Remove from initial state (inside `create`):
```ts
      theme: 'system',
```

Remove setter implementation:
```ts
      setTheme: (theme) => set({ theme }),
```

Remove the `type Theme = ...` line.

- [ ] **Step 5: Delete the dead files**

```bash
rm src/features/SiteHeader.tsx src/features/ApiSite.tsx
rm src/components/ThemeProvider.tsx src/components/ThemeToggle.tsx
```

- [ ] **Step 6: Remove all `dark:` Tailwind modifiers from src/**

```bash
grep -rn "dark:" src/ --include="*.tsx" --include="*.ts" --include="*.css" | grep -v "katex"
```

For each occurrence, remove the `dark:xxx` class. The most common occurrences are in:
- `src/components/graph/Settings.tsx` — `dark:border-white/8 dark:bg-white/4` etc.
- `src/components/retrieval/QuerySettings.tsx` — `dark:border-white/10 dark:bg-white/8` etc.
- `src/features/GraphViewer.tsx` — `dark:border-white/10 dark:bg-[#1f1c1a]/92` and `dark:bg-black/45`

For each file, find and remove all `dark:*` class tokens from className strings. Keep the light-mode classes intact.

After removal:
```bash
grep -rn "dark:" src/ --include="*.tsx" --include="*.ts" | grep -v "katex"
```
Expected: 0 lines.

- [ ] **Step 7: Verify build and lint**

```bash
bun x tsc --noEmit && bun run lint && bun run build 2>&1 | tail -5
```

Expected: 0 errors for all three.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: delete SiteHeader/ApiSite/ThemeProvider/ThemeToggle, remove dark mode"
```

---

## Phase 2 — WorkspaceShell Container

### Task 8: Create WorkspaceShell and WorkspaceSidebarSection

**Files:**
- Create: `src/components/workspace/WorkspaceShell.tsx`
- Create: `src/components/workspace/WorkspaceSidebarSection.tsx`
- Create: `src/components/workspace/index.ts`

- [ ] **Step 1: Create WorkspaceShell.tsx**

```tsx
import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface WorkspaceShellProps {
  sidebar: ReactNode
  children: ReactNode
  sidebarHeader?: ReactNode
  className?: string
}

export default function WorkspaceShell({
  sidebar,
  children,
  sidebarHeader,
  className,
}: WorkspaceShellProps) {
  return (
    <div className={cn('flex h-full min-h-0 min-w-0 overflow-hidden', className)}>
      <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border bg-background">
        {sidebarHeader && (
          <div className="shrink-0 border-b border-border px-4 py-3">
            {sidebarHeader}
          </div>
        )}
        <div className="shell-sidebar-scroll flex-1 overflow-y-auto px-3 py-3">
          {sidebar}
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-card">
        {children}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Create WorkspaceSidebarSection.tsx**

```tsx
import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface WorkspaceSidebarSectionProps {
  label: string
  action?: ReactNode
  children: ReactNode
  className?: string
}

export default function WorkspaceSidebarSection({
  label,
  action,
  children,
  className,
}: WorkspaceSidebarSectionProps) {
  return (
    <div className={cn('mb-4', className)}>
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--sidebar-section-label)]">
          {label}
        </span>
        {action && <div className="flex items-center">{action}</div>}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  )
}
```

- [ ] **Step 3: Create index.ts**

```ts
export { default as WorkspaceShell } from './WorkspaceShell'
export { default as WorkspaceSidebarSection } from './WorkspaceSidebarSection'
```

- [ ] **Step 4: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/workspace/
git commit -m "feat(workspace): add WorkspaceShell and WorkspaceSidebarSection components"
```

---

### Task 9: Add smoke test for WorkspaceShell

**Files:**
- Create: `src/components/workspace/WorkspaceShell.test.tsx`

- [ ] **Step 1: Create the test file**

```tsx
import { describe, expect, it } from 'bun:test'
import { render } from '@testing-library/react'
import WorkspaceShell from './WorkspaceShell'

describe('WorkspaceShell', () => {
  it('renders sidebar and main content in correct layout', () => {
    const { getByTestId } = render(
      <WorkspaceShell
        sidebar={<div data-testid="sidebar-content">Sidebar</div>}
      >
        <div data-testid="main-content">Main</div>
      </WorkspaceShell>
    )

    expect(getByTestId('sidebar-content').textContent).toBe('Sidebar')
    expect(getByTestId('main-content').textContent).toBe('Main')
  })

  it('renders sidebarHeader when provided', () => {
    const { getByTestId } = render(
      <WorkspaceShell
        sidebar={<div>Sidebar</div>}
        sidebarHeader={<div data-testid="sidebar-header">Header</div>}
      >
        <div>Main</div>
      </WorkspaceShell>
    )

    expect(getByTestId('sidebar-header').textContent).toBe('Header')
  })

  it('renders without sidebarHeader when not provided', () => {
    const { queryByTestId } = render(
      <WorkspaceShell sidebar={<div>Sidebar</div>}>
        <div>Main</div>
      </WorkspaceShell>
    )

    expect(queryByTestId('sidebar-header')).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test**

```bash
bun test src/components/workspace/WorkspaceShell.test.tsx
```

Note: If `@testing-library/react` is not installed, run `bun add -d @testing-library/react` first.

Expected: 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/workspace/WorkspaceShell.test.tsx
git commit -m "test(workspace): add WorkspaceShell smoke tests"
```

---

### Task 10: Wire WorkspaceShell into App.tsx with empty sidebar

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add WorkspaceShell import to App.tsx**

Add to the imports section of `src/App.tsx`:

```tsx
import { WorkspaceShell } from '@/components/workspace'
```

- [ ] **Step 2: Wrap renderWorkspace() output with WorkspaceShell**

In the `renderWorkspace()` function in `src/App.tsx`, wrap each feature component in a `WorkspaceShell` with `sidebar={null}`:

```tsx
const renderWorkspace = () => {
  switch (activeTab) {
    case 'knowledge-graph':
      return (
        <WorkspaceShell sidebar={null}>
          <GraphViewer />
        </WorkspaceShell>
      )
    case 'retrieval':
      return (
        <WorkspaceShell sidebar={null}>
          <RetrievalTesting />
        </WorkspaceShell>
      )
    case 'documents':
    default:
      return (
        <WorkspaceShell sidebar={null}>
          <DocumentManager />
        </WorkspaceShell>
      )
  }
}
```

Note: `sidebar={null}` is temporary — it will be replaced in Phase 3.

However, since WorkspaceShell adds a 256px sidebar pane even when empty, pass `sidebar={<></>}` to avoid layout issues, OR keep `null` and handle it in WorkspaceShell. Update WorkspaceShell to hide the aside when sidebar is null:

```tsx
// In WorkspaceShell.tsx, update aside rendering:
{sidebar !== null && (
  <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-border bg-background">
    ...
  </aside>
)}
```

- [ ] **Step 3: Run existing tests**

```bash
bun test
```

Expected: All existing tests + new WorkspaceShell tests pass.

- [ ] **Step 4: Verify dev server renders all three tabs correctly**

```bash
bun run dev
```

Navigate to each of the 3 tabs. All should render normally (sidebar pane is hidden since null).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/workspace/WorkspaceShell.tsx
git commit -m "feat(app): wrap feature tabs in WorkspaceShell (sidebar=null placeholder)"
```

---

## Phase 3a — Documents Feature

### Task 11: Create DocumentsSidebar

**Files:**
- Create: `src/components/documents/DocumentsSidebar.tsx`

The sidebar needs: folder navigation (section: [文件夹]) + status filter (section: [状态筛选]).

Data sources:
- Folders: passed as props from DocumentManager
- Status counts: passed as props from DocumentManager
- Active folder: passed + callback
- Status filter: passed + callback

- [ ] **Step 1: Create DocumentsSidebar.tsx**

```tsx
import { useTranslation } from 'react-i18next'
import { FolderIcon, FolderOpenIcon, LayersIcon, PlusIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type Folder, type DocStatus } from '@/api/lightrag'
import WorkspaceSidebarSection from '@/components/workspace/WorkspaceSidebarSection'
import Button from '@/components/ui/Button'

type StatusFilter = DocStatus | 'all'

interface StatusCount {
  all: number
  processed: number
  preprocessed: number
  processing: number
  pending: number
  failed: number
}

interface DocumentsSidebarProps {
  folders: Folder[]
  activeFolderId: string | null
  statusFilter: StatusFilter
  statusCounts: StatusCount
  onFolderSelect: (id: string | null) => void
  onStatusFilterChange: (filter: StatusFilter) => void
  onCreateFolder: () => void
}

const statusItems: {
  key: StatusFilter
  labelKey: string
  colorClass: string
  dotClass: string
}[] = [
  { key: 'all',          labelKey: 'documentPanel.documentManager.status.all',          colorClass: 'text-foreground',                    dotClass: 'bg-foreground/40' },
  { key: 'processed',    labelKey: 'documentPanel.documentManager.status.completed',    colorClass: 'text-[var(--status-success-fg)]',    dotClass: 'bg-[var(--status-success-fg)]' },
  { key: 'processing',   labelKey: 'documentPanel.documentManager.status.processing',   colorClass: 'text-[var(--status-info-fg)]',       dotClass: 'bg-[var(--status-info-fg)]' },
  { key: 'pending',      labelKey: 'documentPanel.documentManager.status.pending',      colorClass: 'text-[var(--status-warning-fg)]',    dotClass: 'bg-[var(--status-warning-fg)]' },
  { key: 'preprocessed', labelKey: 'documentPanel.documentManager.status.preprocessed', colorClass: 'text-[var(--status-neutral-fg)]',   dotClass: 'bg-[var(--status-neutral-fg)]' },
  { key: 'failed',       labelKey: 'documentPanel.documentManager.status.failed',       colorClass: 'text-[var(--status-danger-fg)]',     dotClass: 'bg-[var(--status-danger-fg)]' },
]

export default function DocumentsSidebar({
  folders,
  activeFolderId,
  statusFilter,
  statusCounts,
  onFolderSelect,
  onStatusFilterChange,
  onCreateFolder,
}: DocumentsSidebarProps) {
  const { t } = useTranslation()

  const folderCountMap: Record<string, number> = {}
  // "__all__" key holds the total across all folders
  const totalCount = statusCounts.all

  const getCount = (folderId: string | null) => {
    if (folderId === null) return totalCount
    return folderCountMap[folderId] ?? 0
  }

  return (
    <div className="select-none">
      {/* Folders section */}
      <WorkspaceSidebarSection
        label={t('documentPanel.folders.sectionLabel', 'Folders')}
        action={
          <Button
            variant="ghost"
            size="icon"
            className="size-5 rounded-[4px]"
            onClick={onCreateFolder}
            tooltip={t('documentPanel.folders.createButton', 'New folder')}
          >
            <PlusIcon className="size-3" />
          </Button>
        }
      >
        {/* All documents */}
        <FolderItem
          label={t('documentPanel.folders.allDocuments', 'All Documents')}
          icon={activeFolderId === null ? FolderOpenIcon : FolderIcon}
          isActive={activeFolderId === null}
          count={totalCount}
          onClick={() => onFolderSelect(null)}
        />

        {/* User folders */}
        {folders.map((folder) => (
          <FolderItem
            key={folder.id}
            label={folder.name}
            icon={activeFolderId === folder.id ? FolderOpenIcon : FolderIcon}
            isActive={activeFolderId === folder.id}
            count={getCount(folder.id)}
            onClick={() => onFolderSelect(folder.id)}
          />
        ))}
      </WorkspaceSidebarSection>

      {/* Status filter section */}
      <WorkspaceSidebarSection
        label={t('documentPanel.sidebar.statusSection', 'Status')}
      >
        {statusItems.map(({ key, labelKey, colorClass, dotClass }) => {
          const count = statusCounts[key as keyof StatusCount] ?? 0
          const isActive = statusFilter === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => onStatusFilterChange(key)}
              className={cn(
                'flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-[13px] transition-colors',
                isActive
                  ? 'bg-accent font-semibold text-foreground'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              <span className="flex items-center gap-2">
                <span className={cn('size-2 rounded-full', dotClass)} />
                <span className={isActive ? 'text-foreground' : colorClass}>
                  {t(labelKey)}
                </span>
              </span>
              <span className={cn(
                'rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
                isActive ? 'bg-foreground/10 text-foreground' : 'bg-border/40 text-muted-foreground'
              )}>
                {count}
              </span>
            </button>
          )
        })}
      </WorkspaceSidebarSection>
    </div>
  )
}

function FolderItem({
  label,
  icon: Icon,
  isActive,
  count,
  onClick,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  isActive: boolean
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] transition-colors',
        isActive
          ? 'border-l-2 border-primary bg-accent pl-1.5 font-semibold text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      )}
    >
      <Icon className={cn('size-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground/70">{count}</span>
    </button>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/documents/DocumentsSidebar.tsx
git commit -m "feat(documents): add DocumentsSidebar with folder and status filter sections"
```

---

### Task 12: Refactor DocumentManager to use WorkspaceShell

**Files:**
- Modify: `src/features/DocumentManager.tsx`
- Modify: `src/App.tsx`

The goal is:
1. Remove the embedded FolderTree from DocumentManager (was in a 200px left panel)
2. Remove the status filter chips from the toolbar (move to sidebar)
3. Add `activeFolderId`, `statusFilter`, callbacks as controlled props from parent OR keep them internal and expose via DocumentsSidebar
4. Pass `<DocumentsSidebar>` to `WorkspaceShell sidebar` prop in App.tsx

Since the state (`activeFolderId`, `statusFilter`, `folders`, `statusCounts`) all lives inside DocumentManager, the cleanest approach is:
- Keep all state in DocumentManager
- Render DocumentManager with its own WorkspaceShell (removing the one in App.tsx for documents tab)
- Or: lift state up to App.tsx

The spec says "DocumentManager.tsx [改] 用 WorkspaceShell 包裹" — so DocumentManager itself renders the WorkspaceShell. Remove the WorkspaceShell wrapper from App.tsx for the documents case.

- [ ] **Step 1: Update DocumentManager.tsx**

Key changes to make in `src/features/DocumentManager.tsx`:

a) Add imports:
```tsx
import WorkspaceShell from '@/components/workspace/WorkspaceShell'
import DocumentsSidebar from '@/components/documents/DocumentsSidebar'
import CreateFolderDialog from '@/components/documents/CreateFolderDialog'
```

b) Add state for create folder dialog:
```tsx
const [showCreateFolder, setShowCreateFolder] = useState(false)
```

c) Ensure `statusCounts` is shaped correctly to pass to sidebar. The existing `statusCounts` variable is `Record<string, number>`. Create a typed version:
```tsx
const sidebarStatusCounts = {
  all: statusCounts.all ?? documentCounts.all ?? 0,
  processed:    statusCounts.processed    ?? 0,
  preprocessed: statusCounts.preprocessed ?? 0,
  processing:   statusCounts.processing   ?? 0,
  pending:      statusCounts.pending      ?? 0,
  failed:       statusCounts.failed       ?? 0,
}
```

d) In the JSX return, wrap everything in WorkspaceShell:

Replace:
```tsx
return (
  <div className="flex h-full flex-col overflow-hidden">
    {/* Toolbar */}
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-[rgba(0,0,0,0.1)] px-4">
      ...status filter chips...
    </div>
    {/* Body: FolderTree + DocList */}
    <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* Folder tree */}
      <div className="w-[200px] shrink-0 border-r border-[rgba(0,0,0,0.1)] overflow-hidden">
        <FolderTree ... />
      </div>
      {/* Document list */}
      ...
    </div>
  </div>
)
```

With:
```tsx
return (
  <>
    <WorkspaceShell
      sidebar={
        <DocumentsSidebar
          folders={folders}
          activeFolderId={activeFolderId}
          statusFilter={statusFilter}
          statusCounts={sidebarStatusCounts}
          onFolderSelect={handleFolderSelect}
          onStatusFilterChange={handleStatusFilterChange}
          onCreateFolder={() => setShowCreateFolder(true)}
        />
      }
    >
      {/* Toolbar — no status filter chips, they moved to sidebar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Button
          variant="outline" size="sm"
          onClick={scanDocuments}
          tooltip={t('documentPanel.documentManager.scanTooltip')}
          className="rounded-[4px] text-xs"
        >
          <RefreshCwIcon className="size-3.5" />
          {t('documentPanel.documentManager.scanButton')}
        </Button>
        <Button
          variant="outline" size="sm"
          onClick={() => setShowPipelineStatus(true)}
          tooltip={t('documentPanel.documentManager.pipelineStatusTooltip')}
          className={cn('rounded-[4px] text-xs', pipelineBusy && 'animate-pulse border-[rgba(220,87,0,0.4)] bg-[rgba(220,87,0,0.06)]')}
        >
          <ActivityIcon className="size-3.5" />
          {t('documentPanel.documentManager.pipelineStatusButton')}
        </Button>

        <div className="flex flex-1 items-center justify-end gap-1.5">
          {pagination.total_pages > 1 && (
            <PaginationControls ... />
          )}
          {isSelectionMode && (
            <>
              <DeleteDocumentsDialog ... />
              <MoveToFolderDialog ... />
              <Button variant="outline" size="sm" onClick={...} className="rounded-[4px] text-xs">
                {/* select/deselect text */}
              </Button>
            </>
          )}
          {!isSelectionMode && (
            <ClearDocumentsDialog onDocumentsCleared={handleDocumentsCleared} />
          )}
          <UploadDocumentsDialog onDocumentsUploaded={() => handleIntelligentRefresh(undefined, false, 120000)} />
          <Button variant="ghost" size="sm" onClick={handleManualRefresh} disabled={isRefreshing} ...>
            <RotateCcwIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Document list (full width now, no FolderTree column) */}
      <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
        {/* ... existing document list JSX ... */}
      </div>
    </WorkspaceShell>

    <CreateFolderDialog
      open={showCreateFolder}
      onOpenChange={setShowCreateFolder}
      onCreateFolder={async (name) => {
        await handleCreateFolder(name) // if this function exists, else inline the createFolder call
      }}
    />

    {/* Other dialogs: PipelineStatusDialog, etc. */}
    {showPipelineStatus && <PipelineStatusDialog ... />}
  </>
)
```

Note: Check CreateFolderDialog's existing API — it may already handle its own create logic. If so, just pass `open`/`onOpenChange` and folder refresh callback.

Also: Remove the `FolderTree` import since it's no longer used directly in DocumentManager.

e) Remove inline hex values, replace with tokens:
- `border-[rgba(0,0,0,0.1)]` → `border-border`
- `text-[#166534]`, `text-[#991b1b]` etc. → now these are in sidebar, not toolbar

- [ ] **Step 2: Update App.tsx — remove WorkspaceShell wrapper for documents**

Since DocumentManager now renders its own WorkspaceShell, remove the WorkspaceShell wrapper in `renderWorkspace()` for the documents case (or keep it and remove it from inside DocumentManager — decide which level owns it). **Recommended:** Let each feature own its WorkspaceShell. Update App.tsx renderWorkspace:

```tsx
const renderWorkspace = () => {
  switch (activeTab) {
    case 'knowledge-graph':
      return <GraphViewer />
    case 'retrieval':
      return <RetrievalTesting />
    case 'documents':
    default:
      return <DocumentManager />
  }
}
```

And remove the outer WorkspaceShell wrapper added in Task 10. The surrounding `<div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[16px] ...">` in App.tsx remains — it's the white card shell.

- [ ] **Step 3: Verify TypeScript and build**

```bash
bun x tsc --noEmit && bun run build 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 4: Manual test**

```bash
bun run dev
```

Verify in browser:
- Documents tab shows left sidebar with folder + status sections
- Click folders → list updates
- Click status filters → list updates
- Upload/delete/move still work

- [ ] **Step 5: Commit**

```bash
git add src/features/DocumentManager.tsx src/App.tsx
git commit -m "feat(documents): integrate DocumentsSidebar via WorkspaceShell"
```

---

### Task 13: Replace FolderTree inline hex with tokens and update Document Dialogs visually

**Files:**
- Modify: `src/components/documents/FolderTree.tsx`
- Modify: `src/components/documents/UploadDocumentsDialog.tsx`
- Modify: `src/components/documents/ClearDocumentsDialog.tsx`
- Modify: `src/components/documents/DeleteDocumentsDialog.tsx`
- Modify: `src/components/documents/CreateFolderDialog.tsx`
- Modify: `src/components/documents/DeleteFolderDialog.tsx`
- Modify: `src/components/documents/MoveToFolderDialog.tsx`
- Modify: `src/components/documents/PipelineStatusDialog.tsx`

- [ ] **Step 1: Grep for inline hex in documents components**

```bash
grep -nE "#[0-9a-fA-F]{6}" src/components/documents/*.tsx src/features/DocumentManager.tsx
```

For each hex value, map to the correct CSS variable:
- `#0075de` / `#097fe8` → use `text-primary` / `text-ring` / `bg-primary`
- `#166534` → use `text-[var(--status-success-fg)]`
- `#991b1b` → use `text-[var(--status-danger-fg)]`
- `#615d59` → use `text-muted-foreground`
- `#1f1e1c` → use `text-foreground`
- `rgba(0,0,0,0.1)` → use `border-border`

- [ ] **Step 2: Update Dialog components visually**

For each dialog (`*Dialog.tsx`), apply:
- `DialogContent` gets: `bg-card rounded-[16px]` (if using Radix Dialog, check if it applies shadow-deep)
- Title: `text-[22px] font-bold tracking-[-0.25px] text-foreground`
- Description: `text-[14px] text-muted-foreground`
- Remove any `dark:` classes (should be done already from Task 7)

For each dialog that uses `DialogContent`, ensure it looks like:
```tsx
<DialogContent className="rounded-[16px] bg-card shadow-[var(--shadow-deep)] max-w-md">
  <DialogHeader>
    <DialogTitle className="text-[22px] font-bold tracking-[-0.25px]">...</DialogTitle>
    <DialogDescription className="text-[14px] text-muted-foreground">...</DialogDescription>
  </DialogHeader>
  {/* ... */}
</DialogContent>
```

- [ ] **Step 3: Verify no inline hex remains (except SVG)**

```bash
grep -nE "#[0-9a-fA-F]{6}" src/components/documents/*.tsx | grep -v "fill=\|stroke="
```

Expected: 0 lines.

- [ ] **Step 4: Build check**

```bash
bun x tsc --noEmit && bun run build 2>&1 | tail -5
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/documents/
git commit -m "refactor(documents): token-ize inline hex, polish dialog visuals"
```

---

## Phase 3b — Graph Feature

### Task 14: Extract flat display toggles from Settings.tsx

**Files:**
- Modify: `src/components/graph/Settings.tsx`

Currently Settings.tsx is a Popover with toggles inside. We need to extract the toggle panel as a reusable component that can be rendered inline in the sidebar.

- [ ] **Step 1: Read current Settings.tsx fully**

```bash
cat src/components/graph/Settings.tsx
```

- [ ] **Step 2: Add a named export `GraphDisplayToggles` component**

Inside `Settings.tsx`, add a new exported component that renders just the toggles (the same content as inside the Popover), without any Popover wrapper:

```tsx
// Add this export in Settings.tsx (or extract to a new file if it's large)
export function GraphDisplayToggles() {
  const { t } = useTranslation()
  // ... same store hooks as Settings component ...
  
  return (
    <div className="space-y-1">
      <LabeledCheckBox
        checked={showNodeLabel}
        onCheckedChange={() => useSettingsStore.getState().setShowNodeLabel(!showNodeLabel)}
        label={t('graphViewer.settings.showNodeLabel')}
      />
      <LabeledCheckBox
        checked={showEdgeLabel}
        onCheckedChange={() => useSettingsStore.getState().setShowEdgeLabel(!showEdgeLabel)}
        label={t('graphViewer.settings.showEdgeLabel')}
      />
      <LabeledCheckBox
        checked={enableNodeDrag}
        onCheckedChange={() => useSettingsStore.getState().setEnableDrag(!enableNodeDrag)}
        label={t('graphViewer.settings.enableNodeDrag')}
      />
      <LabeledCheckBox
        checked={enableHideUnselectedEdges}
        onCheckedChange={() => useSettingsStore.getState().setEnableHideUnselectedEdges(!enableHideUnselectedEdges)}
        label={t('graphViewer.settings.hideUnselectedEdges')}
      />
      {/* Add other toggles as they exist in current Settings.tsx */}
    </div>
  )
}
```

Note: Read the actual store setter names from the current `Settings.tsx` implementation before writing — don't guess the exact method names.

Also update the `LabeledCheckBox` inside Settings.tsx to remove `dark:` classes (already done in Task 7, verify here).

- [ ] **Step 3: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/graph/Settings.tsx
git commit -m "refactor(graph): export GraphDisplayToggles as flat component"
```

---

### Task 15: Extract LayoutsControl to LayoutSelect

**Files:**
- Modify: `src/components/graph/LayoutsControl.tsx`

- [ ] **Step 1: Read current LayoutsControl.tsx**

```bash
cat src/components/graph/LayoutsControl.tsx
```

- [ ] **Step 2: Add named export `LayoutSelect` component**

Add to `LayoutsControl.tsx`:

```tsx
// New export: flat select for use in sidebar
export function LayoutSelect() {
  const { t } = useTranslation()
  // ... same layout state and handler as current component ...

  return (
    <Select value={currentLayout} onValueChange={handleLayoutChange}>
      <SelectTrigger className="h-8 rounded-[4px] border-border text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {layoutOptions.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {t(opt.labelKey)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
```

Note: Read the actual layout options and store integration from the current file before writing the exact code.

- [ ] **Step 3: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/graph/LayoutsControl.tsx
git commit -m "refactor(graph): export LayoutSelect as flat dropdown"
```

---

### Task 16: Extract GraphLabels to LabelChipList

**Files:**
- Modify: `src/components/graph/GraphLabels.tsx`

- [ ] **Step 1: Read current GraphLabels.tsx**

```bash
cat src/components/graph/GraphLabels.tsx
```

- [ ] **Step 2: Add named export `LabelChipList`**

The current GraphLabels likely renders label chips in a floating div. Extract the chip list logic to a new export that renders inline without the floating wrapper:

```tsx
export function LabelChipList() {
  // ... same store hooks as GraphLabels ...
  
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <button
          key={label}
          type="button"
          onClick={() => handleLabelClick(label)}
          className={cn(
            'rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-[0.125px] transition-colors',
            selectedLabel === label
              ? 'bg-primary text-primary-foreground'
              : 'bg-accent text-accent-foreground hover:bg-accent/80'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
```

Note: Read the actual label state and handlers before writing the exact code.

- [ ] **Step 3: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/graph/GraphLabels.tsx
git commit -m "refactor(graph): export LabelChipList as inline component"
```

---

### Task 17: Extract Legend and GraphSearch to inline components

**Files:**
- Modify: `src/components/graph/Legend.tsx`
- Modify: `src/components/graph/GraphSearch.tsx`

- [ ] **Step 1: Read both files**

```bash
cat src/components/graph/Legend.tsx
cat src/components/graph/GraphSearch.tsx
```

- [ ] **Step 2: Add `LegendList` export to Legend.tsx**

Add a new export that renders just the legend list without the card wrapper or position styling:

```tsx
export function LegendList({ className }: { className?: string }) {
  // ... same data as current Legend ...
  
  return (
    <div className={cn('space-y-1', className)}>
      {legendItems.map((item) => (
        <div key={item.label} className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
          <span className="truncate">{item.label}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Add `GraphSearchInput` export to GraphSearch.tsx**

Add a new export that renders just the search input without Sigma position styles:

```tsx
export function GraphSearchInput({
  value,
  onFocus,
  onChange,
}: {
  value?: string
  onFocus?: () => void
  onChange?: (option: GraphSearchOption | null) => void
}) {
  // Reuse existing search logic from GraphSearch
  // Render just the input without the absolute-positioned wrapper
  return (
    <div className="w-full">
      {/* Same search input content as GraphSearch but without absolute positioning */}
    </div>
  )
}
```

Note: Read the actual implementation to understand what can be reused.

- [ ] **Step 4: Commit**

```bash
git add src/components/graph/Legend.tsx src/components/graph/GraphSearch.tsx
git commit -m "refactor(graph): export LegendList and GraphSearchInput as inline components"
```

---

### Task 18: Create GraphSidebar

**Files:**
- Create: `src/components/graph/GraphSidebar.tsx`

- [ ] **Step 1: Create GraphSidebar.tsx**

```tsx
import { useTranslation } from 'react-i18next'
import WorkspaceSidebarSection from '@/components/workspace/WorkspaceSidebarSection'
import { LabelChipList } from '@/components/graph/GraphLabels'
import { LayoutSelect } from '@/components/graph/LayoutsControl'
import { GraphDisplayToggles } from '@/components/graph/Settings'
import { LegendList } from '@/components/graph/Legend'
import { GraphSearchInput } from '@/components/graph/GraphSearch'
import { useSettingsStore } from '@/stores/settings'

export default function GraphSidebar() {
  const { t } = useTranslation()
  const showLegend = useSettingsStore.use.showLegend()

  return (
    <div>
      <WorkspaceSidebarSection label={t('graphViewer.sidebar.search', 'Node Search')}>
        <GraphSearchInput />
      </WorkspaceSidebarSection>

      <WorkspaceSidebarSection label={t('graphViewer.sidebar.labels', 'Labels')}>
        <LabelChipList />
      </WorkspaceSidebarSection>

      <WorkspaceSidebarSection label={t('graphViewer.sidebar.layout', 'Layout')}>
        <LayoutSelect />
      </WorkspaceSidebarSection>

      <WorkspaceSidebarSection label={t('graphViewer.sidebar.display', 'Display')}>
        <GraphDisplayToggles />
      </WorkspaceSidebarSection>

      {showLegend && (
        <WorkspaceSidebarSection label={t('graphViewer.sidebar.legend', 'Legend')}>
          <LegendList />
        </WorkspaceSidebarSection>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/graph/GraphSidebar.tsx
git commit -m "feat(graph): add GraphSidebar with search/labels/layout/display/legend sections"
```

---

### Task 19: Update GraphViewer to use WorkspaceShell

**Files:**
- Modify: `src/features/GraphViewer.tsx`

- [ ] **Step 1: Add imports to GraphViewer.tsx**

```tsx
import WorkspaceShell from '@/components/workspace/WorkspaceShell'
import GraphSidebar from '@/components/graph/GraphSidebar'
```

- [ ] **Step 2: Wrap the SigmaContainer with WorkspaceShell**

Replace the outer `<div className="relative h-full w-full overflow-hidden">` return with:

```tsx
return (
  <WorkspaceShell sidebar={<GraphSidebar />}>
    <div className="relative h-full w-full overflow-hidden">
      <SigmaContainer ... >
        <GraphControl />
        {enableNodeDrag && <GraphEvents />}
        <FocusOnNode node={autoFocusedNode} move={moveToSelectedNode} />

        {/* Remove: GraphLabels and GraphSearch from top-left (moved to sidebar) */}
        {/* Remove: LayoutsControl, LegendButton, Settings from bottom-left (moved to sidebar) */}
        {/* Keep: ZoomControl and FullScreenControl at bottom-right */}
        <div className="absolute bottom-4 right-4 flex flex-col rounded-[12px] border border-border bg-white/92 p-1.5 shadow-[var(--shadow-card)] backdrop-blur-xl">
          <ZoomControl />
          <FullScreenControl />
        </div>

        {/* Keep: PropertiesView at top-right */}
        {showPropertyPanel && (
          <div className="absolute top-4 right-4 z-10">
            <PropertiesView />
          </div>
        )}

        <SettingsDisplay />
      </SigmaContainer>

      {/* Loading overlay */}
      {isFetching && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/72 backdrop-blur-sm">
          <div className="rounded-[16px] border border-border bg-card px-6 py-5 text-center shadow-[var(--shadow-card)]">
            <div className="mx-auto mb-2 h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent"></div>
            <p className="text-sm font-medium text-muted-foreground">Loading Graph Data...</p>
          </div>
        </div>
      )}
    </div>
  </WorkspaceShell>
)
```

Note: Remove the `isThemeSwitching` variable and its usage since dark mode is gone. Also remove any `isDarkTheme` references in `createSigmaSettings` — use `false` (always light).

- [ ] **Step 3: Remove unused imports**

After the refactor, remove:
- `import GraphLabels from '@/components/graph/GraphLabels'` (the default export, if now unused)
- `import LayoutsControl from '@/components/graph/LayoutsControl'`
- `import Settings from '@/components/graph/Settings'`
- `import Legend from '@/components/graph/Legend'`
- `import LegendButton from '@/components/graph/LegendButton'`
- Any `useTheme` hook usage

Keep:
- `import ZoomControl from '@/components/graph/ZoomControl'`
- `import FullScreenControl from '@/components/graph/FullScreenControl'`
- `import PropertiesView from '@/components/graph/PropertiesView'`
- `import GraphSearch from '@/components/graph/GraphSearch'` only if still used directly

- [ ] **Step 4: Verify TypeScript and build**

```bash
bun x tsc --noEmit && bun run build 2>&1 | tail -10
```

Expected: 0 errors.

- [ ] **Step 5: Manual test**

```bash
bun run dev
```

Verify:
- Graph tab shows left sidebar with search/labels/layout/display sections
- Clicking a label loads the graph
- Zoom and FullScreen controls visible in bottom-right
- Node properties appear top-right when node selected

- [ ] **Step 6: Clean up inline hex in graph files**

```bash
grep -nE "#[0-9a-fA-F]{6}" src/features/GraphViewer.tsx src/components/graph/*.tsx | grep -v "fill=\|stroke="
```

Replace remaining hex values with tokens.

- [ ] **Step 7: Commit**

```bash
git add src/features/GraphViewer.tsx src/components/graph/
git commit -m "feat(graph): integrate GraphSidebar via WorkspaceShell, remove floating panels"
```

---

## Phase 3c — Retrieval Feature

### Task 20: Flatten QuerySettings to sidebar-ready form

**Files:**
- Modify: `src/components/retrieval/QuerySettings.tsx`

Currently QuerySettings uses Card/CardHeader/CardContent wrappers and renders as a standalone settings panel. We need to expose the form fields in a flat layout suitable for the sidebar.

- [ ] **Step 1: Read the full QuerySettings.tsx**

```bash
cat src/components/retrieval/QuerySettings.tsx
```

- [ ] **Step 2: Restructure QuerySettings to render flat form**

The component currently renders itself as a card. Remove the Card/CardHeader/CardContent wrapper and make it render flat form fields. The form content (Select for mode, Inputs for top_k etc., Checkboxes for options) should remain, but without the card wrapper.

Key changes:
- Remove `import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card'`
- Remove the outer Card wrapper in JSX
- Keep all form inputs intact
- Remove `dark:` prefixes (already done in Task 7, verify here)
- Replace inline hex with tokens:
  - `dark:border-white/10` → removed
  - `bg-white/90` → `bg-card`
  - `border-black/10` → `border-border`
  - `text-[#8a847e]` → `text-[var(--sidebar-section-label)]`

The component should just return the form fields in a div with `space-y-3` or similar spacing.

- [ ] **Step 3: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/retrieval/QuerySettings.tsx
git commit -m "refactor(retrieval): flatten QuerySettings to sidebar-ready form"
```

---

### Task 21: Create RetrievalSidebar

**Files:**
- Create: `src/components/retrieval/RetrievalSidebar.tsx`

- [ ] **Step 1: Create RetrievalSidebar.tsx**

```tsx
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { EraserIcon, CopyIcon } from 'lucide-react'
import WorkspaceSidebarSection from '@/components/workspace/WorkspaceSidebarSection'
import QuerySettings from '@/components/retrieval/QuerySettings'
import Button from '@/components/ui/Button'

interface RetrievalSidebarProps {
  onClearHistory: () => void
  onCopyAll: () => void
}

export default function RetrievalSidebar({
  onClearHistory,
  onCopyAll,
}: RetrievalSidebarProps) {
  const { t } = useTranslation()

  return (
    <div>
      <WorkspaceSidebarSection label={t('retrievalPanel.sidebar.settings', 'Query Settings')}>
        <QuerySettings />
      </WorkspaceSidebarSection>

      <WorkspaceSidebarSection label={t('retrievalPanel.sidebar.actions', 'Actions')}>
        <div className="space-y-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 rounded-[6px] text-[13px]"
            onClick={onClearHistory}
          >
            <EraserIcon className="size-3.5" />
            {t('retrievalPanel.clearHistory', 'Clear conversation')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 rounded-[6px] text-[13px]"
            onClick={onCopyAll}
          >
            <CopyIcon className="size-3.5" />
            {t('retrievalPanel.copyAll', 'Copy all')}
          </Button>
        </div>
      </WorkspaceSidebarSection>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
bun x tsc --noEmit 2>&1 | head -20
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/retrieval/RetrievalSidebar.tsx
git commit -m "feat(retrieval): add RetrievalSidebar with query settings and action buttons"
```

---

### Task 22: Refactor RetrievalTesting with WorkspaceShell and Notion chat bubbles

**Files:**
- Modify: `src/features/RetrievalTesting.tsx`
- Modify: `src/components/retrieval/ChatMessage.tsx`

- [ ] **Step 1: Read RetrievalTesting.tsx fully**

```bash
cat src/features/RetrievalTesting.tsx
```

- [ ] **Step 2: Update RetrievalTesting.tsx**

Add imports:
```tsx
import WorkspaceShell from '@/components/workspace/WorkspaceShell'
import RetrievalSidebar from '@/components/retrieval/RetrievalSidebar'
import NotionCard from '@/components/ui/NotionCard'
```

Wrap the return JSX with WorkspaceShell:
```tsx
return (
  <WorkspaceShell sidebar={<RetrievalSidebar onClearHistory={handleClearHistory} onCopyAll={handleCopyAll} />}>
    {/* Chat area */}
    <div className="flex h-full flex-col overflow-hidden">
      {/* Messages scroll area */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border p-4">
        <NotionCard variant="raised" className="flex items-end gap-3 p-3">
          <Textarea
            value={currentQuery}
            onChange={(e) => setCurrentQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('retrievalPanel.queryPlaceholder')}
            className="min-h-[60px] flex-1 resize-none border-none bg-transparent shadow-none focus-visible:ring-0"
          />
          <Button
            onClick={handleSend}
            disabled={!currentQuery.trim() || isStreaming}
            size="icon"
            className="mb-0.5 shrink-0"
          >
            <SendIcon className="size-4" />
          </Button>
        </NotionCard>
      </div>
    </div>
  </WorkspaceShell>
)
```

Also move the `handleClearHistory` and `handleCopyAll` logic from wherever they currently are (they might be inline in the JSX) to named callbacks:
```tsx
const handleClearHistory = useCallback(() => {
  useSettingsStore.getState().setRetrievalHistory([])
}, [])

const handleCopyAll = useCallback(() => {
  const text = messages.map(m => `${m.role}: ${m.content}`).join('\n\n')
  copyToClipboard(text)
  toast.success(t('retrievalPanel.copySuccess', 'Copied to clipboard'))
}, [messages, t])
```

- [ ] **Step 3: Update ChatMessage.tsx for Notion bubble style**

Read the current file:
```bash
cat src/components/retrieval/ChatMessage.tsx
```

Update bubble styling:
- User messages: `bg-[#f2f9ff] rounded-[12px_12px_4px_12px]` aligned right
- Assistant messages: `bg-card border border-border rounded-[12px_12px_12px_4px]` aligned left
- Source footnotes: `text-muted-foreground text-[11px] border-t border-border/40 mt-2 pt-2`
- Remove all `dark:` classes

Example structure:
```tsx
<div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
  <div
    className={cn(
      'max-w-[85%] px-4 py-3 text-sm',
      isUser
        ? 'rounded-[12px_12px_4px_12px] bg-[#f2f9ff] text-foreground'
        : 'rounded-[12px_12px_12px_4px] border border-border bg-card text-foreground'
    )}
  >
    {/* message content */}
  </div>
</div>
```

- [ ] **Step 4: Verify TypeScript and build**

```bash
bun x tsc --noEmit && bun run build 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 5: Manual test**

```bash
bun run dev
```

Verify:
- Retrieval tab shows left sidebar with QuerySettings + action buttons
- Chat messages render with correct bubble styles
- Send query → streaming response appears
- Clear/Copy buttons work

- [ ] **Step 6: Clean up inline hex**

```bash
grep -nE "#[0-9a-fA-F]{6}" src/features/RetrievalTesting.tsx src/components/retrieval/*.tsx | grep -v "fill=\|stroke="
```

Replace remaining hex with tokens.

- [ ] **Step 7: Commit**

```bash
git add src/features/RetrievalTesting.tsx src/components/retrieval/
git commit -m "feat(retrieval): integrate RetrievalSidebar, redesign chat bubbles"
```

---

## Phase 4 — Polish

### Task 23: Polish all remaining Dialogs (visual only)

**Files:**
- Modify: `src/components/graph/MergeDialog.tsx`
- Modify: `src/components/graph/PropertyEditDialog.tsx`
- Modify: `src/components/ApiKeyAlert.tsx`

(Document dialogs were already updated in Task 13)

- [ ] **Step 1: Find all remaining dialog files**

```bash
grep -rl "DialogContent" src/ --include="*.tsx" | grep -v node_modules
```

- [ ] **Step 2: Apply Notion dialog treatment to each**

For each remaining dialog that has `DialogContent`, ensure:
```tsx
<DialogContent className="rounded-[16px] bg-card shadow-[var(--shadow-deep)] max-w-md">
  <DialogHeader>
    <DialogTitle className="text-[22px] font-bold tracking-[-0.25px]">
      {/* title */}
    </DialogTitle>
    <DialogDescription className="text-[14px] text-muted-foreground">
      {/* description */}
    </DialogDescription>
  </DialogHeader>
  {/* content */}
  <DialogFooter>
    {/* buttons — use existing <Button> component */}
  </DialogFooter>
</DialogContent>
```

For `ApiKeyAlert.tsx`, apply the same treatment.

Remove any remaining `dark:` classes.

- [ ] **Step 3: Check all inline hex in dialog files**

```bash
grep -nE "#[0-9a-fA-F]{6}" src/components/graph/MergeDialog.tsx src/components/graph/PropertyEditDialog.tsx src/components/ApiKeyAlert.tsx | grep -v "fill=\|stroke="
```

Replace with tokens.

- [ ] **Step 4: Build check**

```bash
bun x tsc --noEmit && bun run build 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/graph/MergeDialog.tsx src/components/graph/PropertyEditDialog.tsx src/components/ApiKeyAlert.tsx
git commit -m "style(dialogs): apply Notion visual treatment to remaining dialogs"
```

---

### Task 24: Polish LoginPage

**Files:**
- Modify: `src/features/LoginPage.tsx`

- [ ] **Step 1: Read the current LoginPage.tsx**

```bash
cat src/features/LoginPage.tsx
```

- [ ] **Step 2: Apply Notion polish**

Key changes:
- Wrap the login card in `NotionCard variant="raised"` with `rounded-[16px]` and `max-w-[400px]`
- Card should be centered on the page with the body gradient background
- Title: `text-[22px] font-bold tracking-[-0.25px]`
- Inputs: `border-border rounded-[4px] focus:ring-ring`
- Submit button: use existing `<Button>` default variant, full width
- Remove all `dark:` classes (already done in Task 7)
- Replace inline hex with tokens

Example structure:
```tsx
<div className="flex min-h-screen items-center justify-center p-6">
  <NotionCard variant="raised" className="w-full max-w-[400px] rounded-[16px] p-8">
    {/* Logo + title */}
    <div className="mb-8 flex items-center gap-3">
      <div className="flex size-11 items-center justify-center rounded-[10px] bg-primary text-primary-foreground">
        <ZapIcon className="size-5" />
      </div>
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
          {/* brand badge */}
        </div>
        <div className="text-[22px] font-bold tracking-[-0.25px]">{SiteInfo.name}</div>
      </div>
    </div>

    {/* Form */}
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1.5 block text-[13px] font-semibold text-foreground">
          API Key
        </label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          className="rounded-[4px] border-border"
          placeholder="Enter your API key"
        />
      </div>
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? 'Signing in...' : 'Sign in'}
      </Button>
    </form>
  </NotionCard>
</div>
```

Note: Keep existing auth logic exactly as-is. Only change visual structure.

- [ ] **Step 3: Add NotionCard import**

```tsx
import NotionCard from '@/components/ui/NotionCard'
```

- [ ] **Step 4: Build check**

```bash
bun x tsc --noEmit && bun run build 2>&1 | tail -5
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/LoginPage.tsx
git commit -m "style(login): apply Notion visual treatment to LoginPage"
```

---

### Task 25: Update i18n files with new sidebar keys

**Files:**
- Modify: `src/locales/zh.json`
- Modify: `src/locales/en.json`

- [ ] **Step 1: Identify all new i18n keys added in Phases 1-4**

Search for i18n keys used in new components:
```bash
grep -rn "t('" src/components/workspace/ src/components/documents/DocumentsSidebar.tsx src/components/graph/GraphSidebar.tsx src/components/retrieval/RetrievalSidebar.tsx | grep -oP "'[^']+'" | sort -u
```

- [ ] **Step 2: Add new keys to en.json**

Open `src/locales/en.json` and add the new keys. Based on the code written in this plan, the following keys are needed:

```json
{
  "documentPanel": {
    "folders": {
      "sectionLabel": "Folders",
      "allDocuments": "All Documents",
      "createButton": "New folder"
    },
    "sidebar": {
      "statusSection": "Status"
    }
  },
  "graphViewer": {
    "sidebar": {
      "search": "Node Search",
      "labels": "Labels",
      "layout": "Layout",
      "display": "Display",
      "legend": "Legend"
    }
  },
  "retrievalPanel": {
    "sidebar": {
      "settings": "Query Settings",
      "actions": "Actions"
    },
    "clearHistory": "Clear conversation",
    "copyAll": "Copy all",
    "copySuccess": "Copied to clipboard"
  }
}
```

Note: Check the existing structure in en.json to insert keys at the correct nesting level without duplicating existing keys.

- [ ] **Step 3: Add same keys to zh.json**

```json
{
  "documentPanel": {
    "folders": {
      "sectionLabel": "文件夹",
      "allDocuments": "全部文档",
      "createButton": "新建文件夹"
    },
    "sidebar": {
      "statusSection": "状态筛选"
    }
  },
  "graphViewer": {
    "sidebar": {
      "search": "节点搜索",
      "labels": "标签筛选",
      "layout": "布局",
      "display": "显示设置",
      "legend": "图例"
    }
  },
  "retrievalPanel": {
    "sidebar": {
      "settings": "检索参数",
      "actions": "对话操作"
    },
    "clearHistory": "清空对话",
    "copyAll": "复制全部",
    "copySuccess": "已复制到剪贴板"
  }
}
```

- [ ] **Step 4: Verify other locale files are untouched**

```bash
git diff --name-only
```

Expected: Only `en.json` and `zh.json` in the diff.

- [ ] **Step 5: Commit**

```bash
git add src/locales/en.json src/locales/zh.json
git commit -m "feat(i18n): add new sidebar keys to en and zh locales"
```

---

### Task 26: Final cleanup sweep and full verification

**Files:**
- Various (any remaining issues)

- [ ] **Step 1: Check for remaining dead references**

```bash
grep -rn "from '@/components/ThemeProvider'\|ThemeToggle\|SiteHeader\|ApiSite" src/
```

Expected: 0 lines.

- [ ] **Step 2: Check for remaining dark: modifiers**

```bash
grep -rn "dark:" src/ --include="*.tsx" --include="*.ts" | grep -v "katex"
```

Expected: 0 lines.

- [ ] **Step 3: Check for remaining inline hex in features and component directories**

```bash
grep -rnE "#[0-9a-fA-F]{6}" src/features/*.tsx src/components/documents/*.tsx src/components/graph/*.tsx src/components/retrieval/*.tsx | grep -v "fill=\|stroke=\|constants\|#[0-9a-fA-F]{6}.*\/\/"
```

Expected: Only SVG `fill=` and `stroke=` attributes, no inline styling hex.

- [ ] **Step 4: Run all automated checks**

```bash
bun x tsc --noEmit && bun run lint && bun run build && bun test
```

Expected: All pass with 0 errors.

- [ ] **Step 5: Full manual verification**

```bash
bun run dev
```

Run through the complete manual verification checklist (from design doc section 7):

1. LoginPage: auto-login (guest) / token login / error token
2. Documents tab:
   - Sidebar folder navigation: all / user folders
   - Status filter switching
   - Upload / delete / move / create folder / delete folder
   - Pagination, selection mode
3. Graph tab:
   - Sidebar: select label → graph loads
   - Drag node / click node → PropertiesView appears
   - Layout select / display toggles
   - Zoom / FullScreen controls work
4. Retrieval tab:
   - Sidebar: change mode / params
   - Send query → streaming response + Markdown/LaTeX
   - Clear conversation / copy all
5. All Dialogs: open and verify rounded-[16px] + proper typography
6. Responsive: check at 1280px, 1024px, 768px
7. DevTools console: 0 React warnings, 0 404s

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore: final cleanup sweep — verify zero dark:, zero dead refs, zero inline hex"
```

---

## Verification Summary

| Check | Command | Pass Condition |
|---|---|---|
| TypeScript | `bun x tsc --noEmit` | 0 errors |
| Lint | `bun run lint` | 0 errors |
| Build | `bun run build` | Success |
| Tests | `bun test` | All pass |
| No dark: | `grep -rn "dark:" src/ \| grep -v katex` | 0 lines |
| No dead refs | `grep -rn "ThemeProvider\|SiteHeader\|ApiSite\|ThemeToggle" src/` | 0 lines |
| No inline hex | `grep -rnE "#[0-9a-fA-F]{6}" src/features/*.tsx src/components/{documents,graph,retrieval}/*.tsx \| grep -v "fill=\|stroke="` | SVG only |
| Sidebars present | Manual check | 3 tabs each have 256px sidebar |
| 7 .dark blocks removed | `grep -n "\.dark" src/index.css` | 0 lines |
