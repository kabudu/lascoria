import { useState } from 'react';

type Destination = 'account' | 'start' | 'usage' | 'relay' | 'notifications';
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
    text: 'A session is an independent Muse conversation attached to a folder. New session can create an isolated Git worktree from committed files, leaving uncommitted changes in the original checkout. Use Browse to choose a folder, or enter its full path. Cancelling keeps your entry. Selection stays local until Save or Start; it does not approve Muse tool permissions. Check the chosen folder before starting. Session name is optional at creation; Rename session beside the heading changes it later. Blank names use the folder name. Choose Project in the start dialog to save a named set of up to eight separate folders. Save validates the full paths; the first folder is the default. Start project session sends these roots to Muse. Edit a saved Project for future sessions; existing sessions keep their folders until you tick Use the updated folders for this task above the composer. That applies the new folders with that task, as long as the default folder is unchanged; a new default folder needs a new session. Project worktrees and combined diff captures are unavailable.',
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
    title: 'Find and continue earlier work',
    text: 'Search history in the workspace menu finds words in the latest 100 messages Lascoria keeps for each session, including archived sessions. Choose a result to open that session. An archived session is read-only; Continue in a new session starts a separate session in its retained task folder, or in the original folder if the task folder was discarded, and links the two. Nothing is sent to Muse until you start a task. Export transcript beside the session heading saves those retained messages as a Markdown file you choose; it contains your conversation, so store it privately.',
  },
  {
    title: 'Understand usage and tokens',
    text: 'Account & usage, in the workspace menu, shows Muse’s most recent report of your current-window and weekly subscription allowance, when each resets and how old the report is. Muse reports one allowance for your account, so every session shows the same figures. It does not send a model request or interrupt work. Missing or out-of-date reports are shown as unknown, never as 0% used. Subscription allowance is different from task tokens and API billing; provider billing details remain with your provider. Enter /usage in the composer for the same local view.',
    destination: 'usage',
    action: 'View usage',
  },
  {
    title: 'Choose a Muse skill',
    text: 'Enter / in the task composer to browse skills available to that session. Search and choose a skill, then review the task before sending. Choosing a skill alone does not submit a task. Availability depends on Muse and the session’s folder and configuration; native tool permissions still apply.',
  },
  {
    title: 'Files and attachments',
    text: 'Add image beside the composer attaches PNG, JPEG, GIF or WebP images, up to 5 MB each and 4 per task. Pasting or dropping an image onto the composer does the same. Images wait, privately, for that session until you start a task; they are not sent with steering, and Remove deletes a waiting image. Repository text can be inserted as task context. Video, PDF and other file attachments are not available yet. Typing a filename is not the same as attaching its bytes. Check images and task text before sharing private material.',
  },
  {
    title: 'Messages between local sessions',
    text: 'Connect sessions selects another Lascoria-managed Muse session for the same user on this computer. Sharing saves selected text in a local inbox without calling a model. Ask Muse about this explicitly starts a task when the recipient is idle. The header shows new messages across sessions and opens the exact conversation. Opening does not mark messages viewed. Viewed in Lascoria is a separate user acknowledgement. Optional Muse messaging permission allows at most eight agent messages per connection; disconnect revokes access. Files, conversation histories and tool permissions stay separate.',
    destination: 'relay',
    action: 'Open local messages',
  },
  {
    title: 'Questions, approvals and completed work',
    text: 'Attention lists questions, tool permission requests and work needing inspection. Answer or approve only after reviewing the request. A completed task does not prove its changes are correct. Inspect the diff, tests and evidence for the exact revision. Mark completion inspected acknowledges your review; it does not run tests or accept evidence automatically. Notifications in the workspace menu can also tell you about questions, permission requests, problems and finished tasks while Lascoria is in the background; they name the session, never your task text, and stop when you close Lascoria.',
    destination: 'notifications',
    action: 'Notification settings',
  },
  {
    title: 'Background work, drafts and recovery',
    text: 'Log out in the workspace menu asks what should happen: close Lascoria and keep work running, pause work and quit, or sign out of Muse and quit. You can save the first two as what closing the window does. By default, closing the window leaves authorised work running. Reopening reconnects to retained progress. Drafts save locally; resolve competing copies before closing. Signing out cancels running tasks, because they need your sign-in, and retains conversations for later continuation. An uncertain command is not automatically repeated: inspect its acknowledgement and transcript before retrying. Data & backups in Settings makes private local backups, exports or imports them, and restores one the next time Lascoria starts; your sign-in and billing choice are kept. It also removes archived sessions and compacts older history when storage limits approach, making a backup first and leaving task folders on disk. In-app update recovery is not available yet.',
  },
  {
    title: 'Settings',
    text: 'Settings… in the workspace menu keeps every app setting in one place, grouped by what it affects: Lascoria (general, editor, notifications), Muse (account and usage) and Data & privacy (backups, support report). Type in Search settings to find one by what it controls, for example "theme" or "backup", and press Enter to open the first match. Changes apply straight away.',
  },
  {
    title: 'Commit changes and open your editor',
    text: 'Open in editor beside the session heading opens the session folder in the editor chosen in Settings, Editor; Repository context and new files in the Workspace tab have their own Open in editor buttons. Lascoria passes only the path. Commit changes in the Workspace tab of an isolated task stages every Git-visible change on the task branch and commits it with hooks and signing turned off. It never pushes, and it cannot pick individual files or hunks yet: those are planned.',
  },
  {
    title: 'Updates and troubleshooting',
    text: 'In-app updates are not available yet. Do not replace runtime files while tasks are active. For a disconnected supervisor, reopen Lascoria and inspect retained progress. For provider authentication errors, open Muse account and reconnect. Diagnostics contains local technical timings for troubleshooting; it is not a billing or complete resource report. When asking for help, Support report in Settings prepares a summary of versions, session states and data sizes that you can read before saving; it contains no tasks, conversations, paths, names or keys. Lascoria keeps no log files. Keep transcripts private.',
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
