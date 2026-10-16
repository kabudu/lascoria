import { useState } from 'react';

type Destination = 'account' | 'start' | 'usage' | 'relay';
const guides: { title: string; text: string; destination?: Destination; action?: string }[] = [
  {
    title: 'Install Muse and connect your account',
    text: 'Lascoria needs a compatible Muse installation. Open Muse account to install the tested version or choose an existing installation. Installation starts only when you choose it. If setup fails, retry or choose another supported installation; saved conversations remain available.',
    destination: 'account',
    action: 'Open Muse account',
  },
  {
    title: 'Subscription sign-in and API keys',
    text: 'Continue with Muse opens browser sign-in for your subscription. A signed-in subscription takes precedence over a saved Meta API key. API billing is never selected automatically if subscription access expires. Keys use your operating system’s secure credential store. Reconnect if Muse reports expired or revoked access.',
    destination: 'account',
    action: 'Manage connection',
  },
  {
    title: 'Start a session and choose a folder',
    text: 'A session is an independent Muse conversation attached to a folder. New session can create an isolated Git worktree from committed files, leaving uncommitted changes in the original checkout. Use Browse to choose a folder, or enter its full path. Cancelling keeps your entry. Selection stays local until Save or Start; it does not approve Muse tool permissions. Check the chosen folder before starting. Session name is optional at creation; Rename session beside the heading changes it later. Blank names use the folder name. Choose Project in the start dialog to save a named set of up to eight separate folders. Save validates the full paths; the first folder is the default. Start project session sends these roots to Muse. Edit a saved Project for future sessions; existing sessions keep their applied revision. Project worktrees and combined diff captures are unavailable.',
    destination: 'start',
    action: 'New session',
  },
  {
    title: 'Arrange the constellation',
    text: 'Drag nodes to arrange tasks. Pinch or use Ctrl/Cmd plus the mouse wheel to zoom around the pointer; two-finger scrolling pans. Show tools opens zoom and fit controls. Floating panels can move and collapse without rearranging nodes. Arrow keys navigate nodes; Shift plus an arrow moves the focused node. The task list offers an alternative to the map.',
  },
  {
    title: 'Change model and reasoning effort',
    text: 'Open Session model & effort in the task inspector. Model changes apply at the next model call, which may occur within a running task. Effort changes apply to subsequent tasks. The slider uses the selected model’s supported levels and default. Changing settings retains the conversation and existing approvals.',
  },
  {
    title: 'Understand usage and tokens',
    text: 'Usage shows Muse’s last reported current-window and weekly subscription allowance, its reset times and observation time. It does not send a model request or interrupt work. Missing observations mean unknown usage. Subscription allowance is different from task tokens and API billing; provider billing details remain with your provider. Enter /usage in the composer for the same local view.',
    destination: 'usage',
    action: 'View usage',
  },
  {
    title: 'Choose a Muse skill',
    text: 'Enter / in the task composer to browse skills available to that session. Search and choose a skill, then review the task before sending. Choosing a skill alone does not submit a task. Availability depends on Muse and the session’s folder and configuration; native tool permissions still apply.',
  },
  {
    title: 'Files and attachments',
    text: 'Repository text can be inserted as task context. General image, video and file attachments, including drag-and-drop and clipboard images, are not available yet. Typing a filename is not the same as attaching its bytes. Check the task text before sharing private material.',
  },
  {
    title: 'Messages between local sessions',
    text: 'Connect sessions selects another Lascoria-managed Muse session for the same user on this computer. Sharing saves selected text in a local inbox without calling a model. Ask Muse about this explicitly starts a task when the recipient is idle. The header shows new messages across sessions and opens the exact conversation. Opening does not mark messages viewed. Viewed in Lascoria is a separate user acknowledgement. Optional Muse messaging permission allows at most eight agent messages per connection; disconnect revokes access. Files, conversation histories and tool permissions stay separate.',
    destination: 'relay',
    action: 'Open local messages',
  },
  {
    title: 'Questions, approvals and completed work',
    text: 'Attention lists questions, tool permission requests and work needing inspection. Answer or approve only after reviewing the request. A completed task does not prove its changes are correct. Inspect the diff, tests and evidence for the exact revision. Mark completion inspected acknowledges your review; it does not run tests or accept evidence automatically.',
  },
  {
    title: 'Background work, drafts and recovery',
    text: 'Closing the window leaves the supervisor and authorised work running. Reopening reconnects to retained progress. Drafts save locally; resolve competing copies before closing. Signing out stops Muse hosts and retains interrupted work for later continuation. An uncertain command is not automatically repeated: inspect its acknowledgement and transcript before retrying. Backups and in-app update recovery are not available yet.',
  },
  {
    title: 'Updates and troubleshooting',
    text: 'In-app updates are not available yet. Do not replace runtime files while tasks are active. For a disconnected supervisor, reopen Lascoria and inspect retained progress. For provider authentication errors, open Muse account and reconnect. Diagnostics contains local technical timings for troubleshooting; it is not a billing or complete resource report. Keep logs and transcripts private when asking for support.',
  },
];
export function Help({
  navigate,
  available,
}: {
  navigate: (destination: Destination) => void;
  available: Partial<Record<Destination, boolean>>;
}) {
  const [query, setQuery] = useState('');
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const results = guides.filter((guide) =>
    words.every((word) => `${guide.title} ${guide.text}`.toLocaleLowerCase().includes(word)),
  );
  return (
    <section className="help-panel" aria-label="Lascoria help">
      <p>
        Quick guides, available offline. No account details or questions are sent to a help service.
      </p>
      <label htmlFor="help-search">Search help</label>
      <input
        id="help-search"
        type="search"
        value={query}
        maxLength={200}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Try skills, recovery or local messages"
      />
      <p className="muted" role="status">
        {results.length} {results.length === 1 ? 'guide' : 'guides'}
      </p>
      {!results.length && (
        <p>
          No matching guides. Try fewer words or{' '}
          <button className="quiet-action" onClick={() => setQuery('')}>
            show all guides
          </button>
          .
        </p>
      )}
      <div className="help-results">
        {results.map((guide) => (
          <details key={guide.title} open={words.length ? true : undefined}>
            <summary>{guide.title}</summary>
            <p>{guide.text}</p>
            {guide.destination && available[guide.destination] && (
              <button onClick={() => navigate(guide.destination!)}>{guide.action}</button>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}
