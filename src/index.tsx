import React, {useEffect, useMemo, useState} from 'react';
import {Box, Text, render, useApp, useInput, useStdout} from 'ink';
import {fluentDark, fluentLight, type Theme} from './theme.js';
import {daemonClient} from './daemon-client.js';
import type {ProviderId, SessionSnapshot, SessionSummary} from './daemon-protocol.js';

type Screen = 'splash' | 'providers' | 'credentials' | 'new-session' | 'session' | 'sessions' | 'remote' | 'orchestrator' | 'design' | 'preview' | 'usage' | 'themes' | 'help';
type Provider = 'Claude Code' | 'Codex' | 'OpenRouter';
type Appearance = 'system' | 'dark' | 'light';
type FallbackBehavior = 'always ask' | 'switch automatically' | 'never switch';
type NewSessionField = 'provider' | 'account' | 'directory' | 'task' | 'start';

const projectPath = '/Users/billy/WORK/fluent-code';
const providerRows: Array<{name: Provider; detail: string}> = [
  {name: 'Claude Code', detail: 'subscription · platform credits · api key'},
  {name: 'Codex', detail: 'subscription · api key'},
  {name: 'OpenRouter', detail: 'api key · model routing'}
];
const darkThemes = ['Fluent Dark', 'Midnight', 'Ember', 'Nord Dark', 'High Contrast Dark'];
const lightThemes = ['Fluent Light', 'Paper', 'Nord Light', 'High Contrast Light'];

function formatCountdown(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

function Mark({theme}: {theme: Theme}) {
  return <Box flexDirection="column"><Text color={theme.ink}>● ●</Text><Text color={theme.ink}>● <Text color={theme.coral}>●</Text></Text></Box>;
}

function Chrome({theme, title, badge}: {theme: Theme; title: string; badge?: string}) {
  return <Box justifyContent="space-between" borderStyle="single" borderColor={theme.border} paddingX={1}>
    <Text color={theme.muted}><Text color={theme.coral}>●</Text> <Text color={theme.warning}>●</Text> <Text color={theme.success}>●</Text>  fluent code — {title}</Text>
    {badge ? <Text color={theme.success}>● {badge}</Text> : <Text color={theme.muted}>local</Text>}
  </Box>;
}

function Footer({theme, children}: {theme: Theme; children: React.ReactNode}) {
  return <Box marginTop={1} paddingX={1} justifyContent="space-between"><Text color={theme.muted}>{children}</Text><Text color={theme.muted}>? help</Text></Box>;
}

function Card({theme, children, active = false, width}: {theme: Theme; children: React.ReactNode; active?: boolean; width?: number | string}) {
  return <Box width={width} borderStyle="round" borderColor={active ? theme.coral : theme.border} paddingX={1} paddingY={1} flexDirection="column">{children}</Box>;
}

function Sparkline({theme, value = '▁▂▂▃▅▄▆▅▇▆█'}: {theme: Theme; value?: string}) {
  return <Text color={theme.success}>{value}</Text>;
}

function Splash({theme}: {theme: Theme}) {
  return <Box flexDirection="column" alignItems="center" marginTop={4}>
    <Box><Mark theme={theme}/></Box>
    <Text color={theme.ink} bold>fluent<Text color={theme.coral}> code</Text></Text>
    <Box marginTop={1}><Text color={theme.muted}>v0.1.0  ·  claude code / codex / openrouter</Text></Box>
    <Box marginTop={3}><Text color={theme.muted}>press enter to open your workspace</Text></Box>
  </Box>;
}

function Providers({theme, selected}: {theme: Theme; selected: number}) {
  return <Box flexDirection="column"><Chrome theme={theme} title="providers" badge="3 available"/><Box marginTop={1} flexDirection="column"><Text color={theme.ink} bold>connect a provider</Text><Text color={theme.muted}>subscription login and api keys have equal weight.</Text></Box><Box marginTop={1} gap={1}>{providerRows.map((provider, index) => <Card key={provider.name} theme={theme} active={index === selected} width={28}><Text color={index === selected ? theme.coral : theme.ink} bold>{index === selected ? '› ' : '  '}{provider.name}</Text><Text color={theme.muted}>{provider.detail}</Text><Text color={theme.success}>● connected</Text></Card>)}<Card theme={theme} width={20}><Text color={theme.ink} bold>+ provider</Text><Text color={theme.muted}>add an adapter</Text></Card></Box><Box marginTop={1}><Card theme={theme} active width="100%"><Text color={theme.ink}>credential chain</Text><Text color={theme.muted}>1 subscription   2 platform api credits   3 api key</Text><Text color={theme.muted}>fallback: always ask · revert when the higher-precedence credential resets</Text></Card></Box><Footer theme={theme}>↑↓ choose provider   enter manage credentials   n new session   esc back</Footer></Box>;
}

function NewSession({theme, selectedProvider, field, directory, task, isStarting, error}: {theme: Theme; selectedProvider: number; field: NewSessionField; directory: string; task: string; isStarting: boolean; error?: string}) {
  const provider = providerRows[selectedProvider]?.name ?? 'Claude Code';
  return <Box flexDirection="column"><Chrome theme={theme} title="new session"/><Box marginTop={1}><Text color={theme.ink} bold>start a terminal agent</Text></Box><Box marginTop={1} gap={1}>{providerRows.slice(0, 2).map((item, index) => <Card key={item.name} theme={theme} active={field === 'provider' && index === selectedProvider} width={30}><Text color={index === selectedProvider ? theme.coral : theme.ink} bold>{index === selectedProvider ? '● ' : '○ '}{item.name}</Text><Text color={theme.muted}>{item.detail}</Text></Card>)}<Card theme={theme} width={22}><Text color={theme.ink}>+ provider</Text><Text color={theme.muted}>add later</Text></Card></Box><Box marginTop={1} flexDirection="column"><Card theme={theme} active={field === 'account'}><Text color={theme.ink}>account · {provider}</Text><Text color={theme.success}>● subscription <Text color={theme.coral}>default</Text></Text><Text color={theme.muted}>● platform api credits</Text><Text color={theme.muted}>● api key</Text></Card><Box marginTop={1}><Card theme={theme} active={field === 'directory'} width="100%"><Text color={theme.muted}>working directory</Text><Text color={theme.ink}>› {directory}{field === 'directory' ? '▏' : ''}</Text></Card></Box><Box marginTop={1}><Card theme={theme} active={field === 'task'} width="100%"><Text color={theme.muted}>starting task (optional)</Text><Text color={task ? theme.ink : theme.muted}>{task || 'what should this session start with?'}{field === 'task' ? '▏' : ''}</Text></Card></Box></Box><Box marginTop={1}><Text backgroundColor={field === 'start' ? theme.coral : theme.raised} color={field === 'start' ? theme.ground : theme.ink}> {isStarting ? ' starting… ' : ' start session '} </Text><Text color={theme.muted}>  creates an independent local PTY session</Text></Box>{error && <Box marginTop={1}><Text color={theme.coral}>▲ {error}</Text></Box>}<Footer theme={theme}>tab switch field   type to edit directory/task   enter start   esc cancel</Footer></Box>;
}

function ActiveSession({theme, usingFallback, secondsToReset, session, error}: {theme: Theme; usingFallback: boolean; secondsToReset: number; session?: SessionSnapshot; error?: string}) {
  const countdown = formatCountdown(secondsToReset);
  const terminalLines = session?.output.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '').trim().split(/\r?\n/).slice(-8) ?? [];
  return <Box flexDirection="column"><Chrome theme={theme} title={session ? `session · ${session.command}` : 'session'} badge={session ? `${session.provider} · ${session.status}` : usingFallback ? 'claude code · platform credits' : 'claude code · subscription'}/>{session ? <Box marginTop={1} flexDirection="column"><Text color={theme.muted}>{session.directory}  ·  {session.id.slice(0, 8)}</Text><Card theme={theme} width="100%"><Text color={theme.muted}>terminal output</Text>{terminalLines.length ? terminalLines.map((line, index) => <Text key={index} color={theme.ink}>{line}</Text>) : <Text color={theme.muted}>waiting for {session.command} to render…</Text>}</Card>{error && <Text color={theme.coral}>▲ {error}</Text>}</Box> : <Box marginTop={1} flexDirection="column"><Text color={theme.muted}>no daemon session attached</Text><Text color={theme.ink}>start one from the new session launcher.</Text></Box>}<Footer theme={theme}>s sessions   n new session   esc back</Footer></Box>;
}

function Sessions({theme, sessions, selected, error}: {theme: Theme; sessions: SessionSummary[]; selected: number; error?: string}) {
  const liveCount = sessions.filter(session => session.status === 'running').length;
  return <Box flexDirection="column"><Chrome theme={theme} title="sessions" badge={`${liveCount} live · fluentd`}/><Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1} justifyContent="space-between"><Text color={theme.ink}>daemon-owned sessions <Text color={theme.coral}>{sessions.length} total</Text></Text><Text color={theme.muted}>detach safely · attach anywhere local</Text></Box><Box marginTop={1} flexDirection="column">{sessions.length ? sessions.map((session, index) => <Box key={session.id} borderStyle="single" borderColor={index === selected ? theme.coral : theme.border} paddingX={1} justifyContent="space-between"><Text color={index === selected ? theme.ink : theme.muted}>› {session.task || session.directory.split('/').at(-1) || 'untitled session'}</Text><Text color={theme.muted}>{session.provider} · {session.command}</Text><Text color={theme.muted}>{session.id.slice(0, 8)}</Text><Text color={session.status === 'running' ? theme.success : theme.warning}>● {session.status}</Text></Box>) : <Card theme={theme} width="100%"><Text color={theme.muted}>no sessions yet — press n to launch an independent provider terminal.</Text></Card>}</Box>{error && <Box marginTop={1}><Text color={theme.coral}>▲ {error}</Text></Box>}<Footer theme={theme}>↑↓ switch session   enter attach   n new session   esc back</Footer></Box>;
}

function Usage({theme}: {theme: Theme}) {
  return <Box flexDirection="column"><Chrome theme={theme} title="usage observatory" badge="local-only · live"/><Box marginTop={1} justifyContent="space-between"><Text color={theme.ink} bold>{projectPath}</Text><Text color={theme.coral}>[5m] </Text><Text color={theme.muted}>session  today  month</Text></Box><Box marginTop={1} gap={1}>{[['total tokens', '56.1k', 'main + subagents'], ['prompt / completion', '39.8k / 8.9k', '7.4k cached'], ['estimated spend', '$2.84', 'today $8.12'], ['burn rate', '1.8k/min', '↑ 14%'], ['quota reset', '47m', 'claude subscription']].map(([label, value, sub], index) => <Card theme={theme} key={label} active={index === 4} width={20}><Text color={theme.muted}>{label}</Text><Text color={index === 4 ? theme.coral : theme.ink} bold>{value}</Text><Text color={theme.muted}>{sub}</Text></Card>)}</Box><Box marginTop={1} gap={1}><Card theme={theme} width="65%"><Text color={theme.ink} bold>token flow · tokens / min</Text><Text color={theme.success}>claude      ▁▂▅▃▆▄▇▅█▆▅</Text><Text color={theme.warning}>codex       ▁▁▂▃▃▅▄▆▅▇█</Text><Text color={theme.muted}>openrouter  ▁▂▁▂▃▂▃▅▃▂▃</Text><Text color={theme.muted}>cache savings  ▂▃▄▅▇▅▆█  ·  31% hit ratio</Text></Card><Card theme={theme} width="35%"><Text color={theme.ink} bold>model × agent</Text><Text color={theme.muted}>sonnet-5  auth      17.3k  62 t/s</Text><Text color={theme.muted}>gpt-5.5   adapter    8.8k  47 t/s</Text><Text color={theme.muted}>sonnet-5  theme     30.0k  58 t/s</Text></Card></Box><Box marginTop={1}><Card theme={theme} width="100%"><Text color={theme.ink} bold>active sessions</Text><Text color={theme.muted}>auth middleware      14.2k main + 3.1k sub    19m   18 tools  $0.72  ● live</Text><Text color={theme.muted}>theme tokens         22.6k main + 7.4k sub    27m   31 tools  $1.44  ● review</Text></Card></Box><Footer theme={theme}>← sessions   r refresh   t themes   esc back</Footer></Box>;
}

function Themes({theme, appearance, systemMode, darkThemeIndex, lightThemeIndex}: {theme: Theme; appearance: Appearance; systemMode: 'dark' | 'light'; darkThemeIndex: number; lightThemeIndex: number}) {
  const mode = appearance === 'system' ? systemMode : appearance;
  const names = mode === 'light' ? lightThemes : darkThemes;
  const selectedIndex = mode === 'light' ? lightThemeIndex : darkThemeIndex;
  const selectedTheme = names[selectedIndex]!;
  const systemDark = darkThemes[darkThemeIndex]!;
  const systemLight = lightThemes[lightThemeIndex]!;
  return <Box flexDirection="column"><Chrome theme={theme} title="themes & appearance"/><Box marginTop={1}><Text color={theme.ink} bold>appearance mode</Text><Text>  </Text>{(['system', 'light', 'dark'] as const).map(item => <Text key={item} color={appearance === item ? theme.coral : theme.muted}>[{appearance === item ? '●' : ' '}] {item}  </Text>)}</Box><Text color={theme.muted}>each mode keeps its own theme, terminal colors, and density.</Text>{appearance === 'system' && <Text color={theme.muted}>system: dark → {systemDark} · light → {systemLight} · current terminal resolves {systemMode}</Text>}<Box marginTop={1} flexDirection="column"><Text color={theme.ink} bold>{mode === 'light' ? 'light themes' : 'dark themes'} <Text color={theme.muted}>· ↑↓ chooses this mode’s independent bundle</Text></Text><Box gap={1}>{names.map((name, index) => <Card theme={theme} key={name} active={index === selectedIndex} width={20}><Text color={index === selectedIndex ? theme.coral : theme.ink}>{index === selectedIndex ? '● ' : '○ '}{name}</Text><Text color={theme.muted}>ansi · syntax · density</Text><Text color={theme.success}>const <Text color={theme.coral}>agent</Text> = run()</Text></Card>)}</Box></Box><Box marginTop={1} gap={1}><Card theme={theme} width="50%"><Text color={theme.ink} bold>current theme bundle</Text><Text color={theme.muted}>ground   surface   ink   muted</Text><Text color={theme.muted}>border   action    warning success</Text><Text color={theme.muted}>ansi 0–15 · mono 14px · compact</Text></Card><Card theme={theme} width="50%"><Text color={theme.ink} bold>live preview · {selectedTheme}</Text><Text color={theme.muted}>› pnpm test auth</Text><Text color={theme.success}>✓ 12 tests passed</Text><Text color={theme.coral}>● ready</Text></Card></Box><Footer theme={theme}>←→ appearance mode   ↑↓ theme bundle   a system mode   enter apply   esc back</Footer></Box>;
}

function Credentials({theme, credentials, selected, behavior}: {theme: Theme; credentials: string[]; selected: number; behavior: FallbackBehavior}) {
  const summary = behavior === 'always ask' ? 'if the subscription hits its limit, ask before switching to platform api credits, then revert once it resets' : behavior === 'switch automatically' ? 'if the subscription hits its limit, switch to platform api credits, then revert once it resets' : 'if the subscription hits its limit, keep this session waiting until it resets';
  return <Box flexDirection="column"><Chrome theme={theme} title="claude code credentials" badge="3 connected"/><Box marginTop={1}><Text color={theme.ink} bold>credential precedence</Text><Text color={theme.muted}>j/k moves the selected connected credential in the local precedence chain.</Text></Box><Box marginTop={1} flexDirection="column">{credentials.map((label, index) => <Box key={label} borderStyle="round" borderColor={index === selected ? theme.coral : theme.border} paddingX={1} justifyContent="space-between"><Text color={theme.muted}>⋮⋮ {index + 1}</Text><Text color={theme.ink}>{label}</Text><Text color={theme.success}>● connected</Text><Text color={index === 0 ? theme.coral : theme.muted}>{index === 0 ? 'active now' : 'fallback'}</Text></Box>)}</Box><Box marginTop={1}><Text color={theme.ink} bold>fallback behavior</Text><Text>  </Text>{(['always ask', 'switch automatically', 'never switch'] as FallbackBehavior[]).map(option => <Text key={option} color={behavior === option ? theme.coral : theme.muted}>[{behavior === option ? '●' : ' '}] {option}  </Text>)}</Box><Box marginTop={1} borderStyle="single" borderColor={theme.border} paddingX={1}><Text color={theme.muted}>{summary}</Text></Box><Footer theme={theme}>↑↓ select credential   j/k reorder   space change fallback   enter save   esc back</Footer></Box>;
}

function Remote({theme}: {theme: Theme}) {
  return <Box flexDirection="column"><Chrome theme={theme} title="remote server" badge="fluentd · buildbox-01"/><Box marginTop={1} justifyContent="space-between"><Text color={theme.ink} bold>ssh://buildbox-01 · {projectPath}</Text><Text color={theme.coral}>[5m]</Text><Text color={theme.muted}> session  today  month</Text></Box><Box marginTop={1} gap={1}><Card theme={theme} width="34%"><Text color={theme.ink} bold>remote terminal</Text><Text color={theme.muted}>$ fluent attach auth-middleware</Text><Text color={theme.success}>● attached · 42ms</Text><Text color={theme.muted}>cpu  ▂▃▅▆▅▇</Text><Text color={theme.muted}>net  ▁▁▂▄▂▃</Text></Card><Card theme={theme} width="33%"><Text color={theme.ink} bold>hardware</Text><Text color={theme.muted}>cpu load     82%  ▃▅▆█▇</Text><Text color={theme.muted}>memory    4.2 / 16 GB</Text><Text color={theme.muted}>disk io       18 MB/s</Text><Text color={theme.muted}>gpu / vram    n/a</Text></Card><Card theme={theme} width="33%"><Text color={theme.ink} bold>software</Text><Text color={theme.muted}>darwin 26.0 · arm64</Text><Text color={theme.muted}>claude 2.1.8 · codex 0.44</Text><Text color={theme.muted}>git main · clean</Text><Text color={theme.success}>● agent daemon healthy</Text></Card></Box><Box marginTop={1}><Card theme={theme} width="100%"><Text color={theme.ink} bold>usage</Text><Text color={theme.success}>claude     ▁▂▄▅▇▆█▅    39.8k prompt · 8.9k completion · 7.4k cache</Text><Text color={theme.warning}>codex      ▁▂▂▄▆▅█      8.8k main + subagents</Text><Text color={theme.coral}>[ open usage observatory ]</Text></Card></Box><Footer theme={theme}>u observatory   s sessions   o orchestrator   esc back</Footer></Box>;
}

function Orchestrator({theme}: {theme: Theme}) {
  const lanes = [['agent-1', 'Claude Code · sonnet-5', 'auth middleware', '17.3k', '▁▃▅▆█'], ['agent-2', 'Codex · gpt-5.5', 'provider adapter', '8.8k', '▁▂▃▅▆'], ['agent-3', 'Claude Code · sonnet-5', 'theme tokens', '30.0k', '▂▄▅█▇'], ['agent-4', 'OpenRouter · kimi', 'paused · review', '6.1k', '▁▂▂▃▄']];
  return <Box flexDirection="column"><Chrome theme={theme} title="parallel orchestration" badge="4 agents live"/><Box marginTop={1} justifyContent="space-between"><Text color={theme.ink}>main + subagents <Text color={theme.coral}>62.2k / 200k tokens</Text> · $3.14</Text><Text color={theme.muted}>+ add agent   pause all   stop all</Text></Box><Box marginTop={1} flexWrap="wrap" gap={1}>{lanes.map((lane, index) => <Card key={lane[0]} theme={theme} active={index === 3} width="49%"><Text color={theme.ink} bold><Text color={index === 3 ? theme.coral : theme.success}>●</Text> {lane[0]}  <Text color={theme.muted}>{lane[1]}</Text></Text><Text color={theme.muted}>{lane[2]}</Text><Text color={theme.muted}>{lane[3]} tokens  <Sparkline theme={theme} value={lane[4]}/></Text><Text color={theme.success}>› editing src/{index === 0 ? 'middleware/auth.ts' : index === 1 ? 'providers/codex.ts' : 'ui/theme.ts'}</Text></Card>)}</Box><Box marginTop={1} gap={1}><Card theme={theme} width="50%"><Text color={theme.ink} bold>shared task board</Text><Text color={theme.success}>● auth callback tests · agent-1</Text><Text color={theme.success}>● codex adapter · agent-2</Text><Text color={theme.warning}>● theme review · agent-3</Text></Card><Card theme={theme} width="50%"><Text color={theme.coral} bold>▲ running low on headroom.</Text><Text color={theme.muted}>4.2 / 16 GB memory · 82% CPU load</Text><Text color={theme.muted}>2 more agents is probably safe — 5 may cause slowdown.</Text><Text color={theme.coral}>[ add anyway ]</Text><Text color={theme.muted}>  [ cancel ]</Text></Card></Box><Footer theme={theme}>a add agent   u observatory   r remote   esc back</Footer></Box>;
}

function DesignWorkspace({theme}: {theme: Theme}) {
  return <Box flexDirection="column"><Chrome theme={theme} title="design workspace" badge="open design adapter · connected"/><Box marginTop={1} gap={1}><Card theme={theme} width="25%"><Text color={theme.ink} bold>design tasks</Text><Text color={theme.coral}>● FLU-218 auth settings</Text><Text color={theme.muted}>● FLU-221 terminal themes</Text><Text color={theme.muted}>● FLU-224 usage table</Text><Text color={theme.success}>● 3 files claimed</Text></Card><Card theme={theme} active width="50%"><Text color={theme.ink} bold>Auth Settings · component spec</Text><Text color={theme.muted}>tokens: card/12 · button/8 · action/coral</Text><Text color={theme.muted}>tree: Settings › Credentials › Fallback</Text><Text color={theme.muted}>states: default · limit reached · switched · reverted</Text><Text color={theme.success}>repo binding  src/ui/credentials.tsx</Text><Text color={theme.muted}>decision: preserve subscription as precedence default</Text></Card><Card theme={theme} width="25%"><Text color={theme.ink} bold>implementation impact</Text><Text color={theme.muted}>agent-1 · ui shell</Text><Text color={theme.muted}>agent-3 · token view</Text><Text color={theme.success}>preview ready</Text><Text backgroundColor={theme.coral} color={theme.ground}> hand off to build </Text></Card></Box><Box marginTop={1}><Text color={theme.muted}>design ●──── review ●──── implementation ●──── visual check ○   ·   commit 9c81ae</Text></Box><Footer theme={theme}>v preview   o orchestrator   n new design task   esc back</Footer></Box>;
}

function Preview({theme}: {theme: Theme}) {
  return <Box flexDirection="column"><Chrome theme={theme} title="preview & visual check" badge="localhost:3000"/><Box marginTop={1} justifyContent="space-between"><Text color={theme.ink}>http://localhost:3000/settings</Text><Text color={theme.muted}>desktop 1440 · reload · inspect</Text></Box><Box marginTop={1} gap={1}><Card theme={theme} width="70%"><Text color={theme.ink} bold>settings / credentials</Text><Text color={theme.muted}>Claude Code</Text><Text color={theme.success}>● subscription     active now</Text><Text color={theme.muted}>● platform api credits</Text><Text color={theme.muted}>● api key</Text><Text color={theme.muted}>fallback behavior  [●] always ask</Text></Card><Card theme={theme} width="30%"><Text color={theme.ink} bold>inspection</Text><Text color={theme.success}>● console clean</Text><Text color={theme.success}>● network 200</Text><Text color={theme.muted}>CredentialsPanel</Text><Text color={theme.muted}>src/ui/credentials.tsx</Text><Text color={theme.muted}>screenshot saved</Text></Card></Box><Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1} justifyContent="space-between"><Text color={theme.muted}>design source  ▂▃▅▆█</Text><Text color={theme.muted}>running app  ▂▃▅▅█</Text><Text color={theme.coral}>△ 1 spacing mismatch</Text><Text color={theme.coral}>[ send mismatch to agent ]</Text></Box><Footer theme={theme}>d design workspace   a approve   c create task   esc back</Footer></Box>;
}

function Help({theme}: {theme: Theme}) {
  const groups = [
    ['navigate', 'n new session   s sessions   p providers   c credentials'],
    ['observe', 'u usage observatory   r remote server   o orchestration'],
    ['design', 'd design workspace   v preview / visual check   t themes'],
    ['controls', '↑↓ choose   tab next field   enter confirm   esc back'],
    ['safety', 'y switch credential only after the limit notice · no action is hidden']
  ];
  return <Box flexDirection="column"><Chrome theme={theme} title="keyboard help"/><Box marginTop={1}><Text color={theme.ink} bold>shortcuts are local to Fluent Code</Text><Text color={theme.muted}>underlying provider CLIs retain their own controls inside terminal sessions.</Text></Box><Box marginTop={1} flexDirection="column">{groups.map(([label, value]) => <Box key={label} borderStyle="single" borderColor={theme.border} paddingX={1}><Text color={theme.coral}>{label.padEnd(10)}</Text><Text color={theme.muted}>{value}</Text></Box>)}</Box><Box marginTop={1} borderStyle="round" borderColor={theme.border} paddingX={1}><Text color={theme.muted}>Fluent coordinates sessions, credentials, and visibility. It does not rewrite an agent’s tool loop or provider conversation.</Text></Box><Footer theme={theme}>esc return to previous screen</Footer></Box>;
}

function SmallViewport({theme, columns, rows}: {theme: Theme; columns: number; rows: number}) {
  return <Box flexDirection="column" borderStyle="round" borderColor={theme.coral} paddingX={1} paddingY={1}><Text color={theme.coral} bold>terminal needs more room</Text><Text color={theme.ink}>Fluent’s dense session, usage, and orchestration views need at least 80 columns and 24 rows.</Text><Text color={theme.muted}>current: {columns} × {rows}  ·  resize the terminal, then Fluent will resume automatically.</Text></Box>;
}

function App() {
  const {exit} = useApp();
  const {stdout} = useStdout();
  const [screen, setScreen] = useState<Screen>('splash');
  const [viewport, setViewport] = useState({columns: stdout.columns || 80, rows: stdout.rows || 24});
  const [history, setHistory] = useState<Screen[]>([]);
  const [providerIndex, setProviderIndex] = useState(0);
  const [appearance, setAppearance] = useState<Appearance>('dark');
  const [darkThemeIndex, setDarkThemeIndex] = useState(0);
  const [lightThemeIndex, setLightThemeIndex] = useState(0);
  const [usingFallback, setUsingFallback] = useState(false);
  const [secondsToReset, setSecondsToReset] = useState(47 * 60 + 12);
  const [newSessionField, setNewSessionField] = useState<NewSessionField>('provider');
  const [directory, setDirectory] = useState(projectPath);
  const [startingTask, setStartingTask] = useState('');
  const [daemonSessions, setDaemonSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionSnapshot>();
  const [sessionIndex, setSessionIndex] = useState(0);
  const [daemonError, setDaemonError] = useState<string>();
  const [isStarting, setIsStarting] = useState(false);
  const [credentialOrder, setCredentialOrder] = useState(['Subscription', 'Platform API Credits', 'API Key']);
  const [credentialIndex, setCredentialIndex] = useState(0);
  const [fallbackBehavior, setFallbackBehavior] = useState<FallbackBehavior>('always ask');
  const systemMode: 'dark' | 'light' = process.env.FLUENT_SYSTEM_THEME === 'light' ? 'light' : 'dark';
  const resolvedMode = appearance === 'system' ? systemMode : appearance;
  const theme = useMemo(() => resolvedMode === 'light' ? fluentLight : fluentDark, [resolvedMode]);
  const navigate = (next: Screen) => {
    setHistory(stack => [...stack, screen]);
    setScreen(next);
  };
  const goBack = () => {
    const previous = history.at(-1);
    setHistory(stack => stack.slice(0, -1));
    setScreen(previous ?? (screen === 'providers' ? 'splash' : 'sessions'));
  };

  useEffect(() => {
    const updateViewport = () => setViewport({columns: stdout.columns || 80, rows: stdout.rows || 24});
    stdout.on('resize', updateViewport);
    return () => {
      stdout.off('resize', updateViewport);
    };
  }, [stdout]);

  useEffect(() => {
    const timer = setInterval(() => setSecondsToReset(value => Math.max(0, value - 1)), 1_000);
    return () => clearInterval(timer);
  }, []);

  const refreshSessions = () => {
    void daemonClient.listSessions()
      .then(sessions => {
        setDaemonSessions(current => JSON.stringify(current) === JSON.stringify(sessions) ? current : sessions);
        setSessionIndex(index => Math.min(index, Math.max(0, sessions.length - 1)));
        setDaemonError(undefined);
      })
      .catch(error => setDaemonError(error.message));
  };

  useEffect(() => {
    refreshSessions();
    const timer = setInterval(refreshSessions, 1_500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!activeSession) return;
    const timer = setInterval(() => {
      void daemonClient.getSession(activeSession.id)
        .then(snapshot => {
          setActiveSession(snapshot);
          setDaemonError(undefined);
        })
        .catch(error => setDaemonError(error.message));
    }, 700);
    return () => clearInterval(timer);
  }, [activeSession?.id]);

  const startSession = () => {
    const providers: ProviderId[] = ['claude', 'codex'];
    const provider = providers[providerIndex];
    if (!provider) return setDaemonError('OpenRouter is planned as a Claude adapter preset; choose Claude Code or Codex for this first daemon slice.');
    setIsStarting(true);
    setDaemonError(undefined);
    void daemonClient.createSession({provider, directory, task: startingTask || undefined})
      .then(async session => {
        const snapshot = await daemonClient.getSession(session.id);
        setActiveSession(snapshot);
        setStartingTask('');
        refreshSessions();
        navigate('session');
      })
      .catch(error => setDaemonError(error.message))
      .finally(() => setIsStarting(false));
  };

  useInput((input, key) => {
    if (input === 'q' && screen === 'splash') return exit();
    if (screen === 'splash' && (key.return || input === ' ')) return navigate('providers');
    if (key.escape) return goBack();
    if (input === '?') return navigate('help');
    if (screen === 'new-session') {
      const fields: NewSessionField[] = ['provider', 'account', 'directory', 'task', 'start'];
      if (key.tab || input === '\t') return setNewSessionField(current => fields[(fields.indexOf(current) + 1) % fields.length]!);
      if (key.backspace && newSessionField === 'directory') return setDirectory(value => value.slice(0, -1));
      if (key.backspace && newSessionField === 'task') return setStartingTask(value => value.slice(0, -1));
      if (input && !key.return && newSessionField === 'directory') return setDirectory(value => value + input);
      if (input && !key.return && newSessionField === 'task') return setStartingTask(value => value + input);
      if (key.return && newSessionField === 'start' && !isStarting) return startSession();
    }
    if (screen === 'credentials') {
      if (key.upArrow) return setCredentialIndex(index => Math.max(0, index - 1));
      if (key.downArrow) return setCredentialIndex(index => Math.min(credentialOrder.length - 1, index + 1));
      if (input === 'j' && credentialIndex < credentialOrder.length - 1) {
        setCredentialOrder(order => order.map((item, index, items) => index === credentialIndex ? items[index + 1]! : index === credentialIndex + 1 ? items[index - 1]! : item));
        return setCredentialIndex(index => index + 1);
      }
      if (input === 'k' && credentialIndex > 0) {
        setCredentialOrder(order => order.map((item, index, items) => index === credentialIndex ? items[index - 1]! : index === credentialIndex - 1 ? items[index + 1]! : item));
        return setCredentialIndex(index => index - 1);
      }
      if (input === ' ') return setFallbackBehavior(current => current === 'always ask' ? 'switch automatically' : current === 'switch automatically' ? 'never switch' : 'always ask');
    }
    if (screen === 'themes') {
      const modes: Appearance[] = ['system', 'light', 'dark'];
      if (key.leftArrow) return setAppearance(current => modes[(modes.indexOf(current) + modes.length - 1) % modes.length]!);
      if (key.rightArrow) return setAppearance(current => modes[(modes.indexOf(current) + 1) % modes.length]!);
      const mode = appearance === 'system' ? systemMode : appearance;
      const maxIndex = (mode === 'light' ? lightThemes : darkThemes).length - 1;
      if (key.upArrow) return mode === 'light' ? setLightThemeIndex(index => Math.max(0, index - 1)) : setDarkThemeIndex(index => Math.max(0, index - 1));
      if (key.downArrow) return mode === 'light' ? setLightThemeIndex(index => Math.min(maxIndex, index + 1)) : setDarkThemeIndex(index => Math.min(maxIndex, index + 1));
      if (input === 'a') return setAppearance('system');
    }
    if (screen === 'sessions') {
      if (key.upArrow) return setSessionIndex(index => Math.max(0, index - 1));
      if (key.downArrow) return setSessionIndex(index => Math.min(daemonSessions.length - 1, index + 1));
      if (key.return && daemonSessions[sessionIndex]) {
        return void daemonClient.getSession(daemonSessions[sessionIndex]!.id)
          .then(snapshot => {
            setActiveSession(snapshot);
            navigate('session');
          })
          .catch(error => setDaemonError(error.message));
      }
    }
    if (key.upArrow) setProviderIndex(index => Math.max(0, index - 1));
    if (key.downArrow) setProviderIndex(index => Math.min(2, index + 1));
    if (input === 'n') return navigate('new-session');
    if (input === 's') return navigate('sessions');
    if (input === 'u') return navigate('usage');
    if (input === 't') return navigate('themes');
    if (input === 'p') return navigate('providers');
    if (input === 'c') return navigate('credentials');
    if (input === 'r') return navigate('remote');
    if (input === 'o') return navigate('orchestrator');
    if (input === 'd') return navigate('design');
    if (input === 'v') return navigate('preview');
    if (input === 'y' && screen === 'session') return setUsingFallback(true);
    if (input === 'w' && screen === 'session') return setUsingFallback(false);
    if (key.return && screen === 'providers') return navigate('credentials');
  });

  const body = screen === 'splash' ? <Splash theme={theme}/> : screen === 'providers' ? <Providers theme={theme} selected={providerIndex}/> : screen === 'credentials' ? <Credentials theme={theme} credentials={credentialOrder} selected={credentialIndex} behavior={fallbackBehavior}/> : screen === 'new-session' ? <NewSession theme={theme} selectedProvider={providerIndex} field={newSessionField} directory={directory} task={startingTask} isStarting={isStarting} error={daemonError}/> : screen === 'session' ? <ActiveSession theme={theme} usingFallback={usingFallback} secondsToReset={secondsToReset} session={activeSession} error={daemonError}/> : screen === 'sessions' ? <Sessions theme={theme} sessions={daemonSessions} selected={sessionIndex} error={daemonError}/> : screen === 'remote' ? <Remote theme={theme}/> : screen === 'orchestrator' ? <Orchestrator theme={theme}/> : screen === 'design' ? <DesignWorkspace theme={theme}/> : screen === 'preview' ? <Preview theme={theme}/> : screen === 'usage' ? <Usage theme={theme}/> : screen === 'themes' ? <Themes theme={theme} appearance={appearance} systemMode={systemMode} darkThemeIndex={darkThemeIndex} lightThemeIndex={lightThemeIndex}/> : <Help theme={theme}/>;
  const tooSmall = viewport.columns < 80 || viewport.rows < 24;
  return <Box flexDirection="column" backgroundColor={theme.ground} padding={1} minHeight={tooSmall ? 6 : 30}>{tooSmall ? <SmallViewport theme={theme} columns={viewport.columns} rows={viewport.rows}/> : body}</Box>;
}

export default App;

render(<App/>);
