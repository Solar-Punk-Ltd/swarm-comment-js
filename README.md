# Swarm Comment JS Library 🐝💬

The core client-side library for building decentralized comment applications over [Swarm](https://www.ethswarm.org/). This library provides the essential logic for sending, receiving, and managing comment messages within a Swarm ecosystem.

The current reference implementation works with the [Solar-Punk-Ltd/comment-system](https://github.com/Solar-Punk-Ltd/comment-system).

---

## ⚙️ How It Works

`swarm-comment-js` enables decentralized communication by leveraging Swarm's graffiti feeds.

Users upload their messages via updates to a common (graffiti) Swarm feed. There is no notification serive for reading the updates, the user needs to poll the graffiti feed.

---

## 📦 Installation

You can install the library using npm or pnpm:

```bash
npm/pnpm install @solarpunkltd/swarm-comment-js
```

---

## 🛠️ Core Concepts & API

### Imports

```typescript
import { EVENTS, SwarmComment, CommentSettings } from '@solarpunkltd/swarm-comment-js';
import { MessageData, MessageType } from '@solarpunkltd/comment-system';
```

### `CommentSettings` Interface

This configuration object is crucial for initializing the `SwarmComment` instance.

```typescript
export interface CommentSettings {
  user: {
    /** Private key of the comment user, used for signing updates to the Swarm feed. */
    privateKey: string;
    /** Display name or nickname of the current user. */
    nickname: string;
  };
  infra: {
    /** URL of the Bee node used by the client to write to their own feed and to poll the comment feed. */
    beeUrl: string;
    /** Optional: Postage stamp ID. Required if `enveloped` is true, unless `beeUrl` points to a gateway with auto-stamping capabilities. */
    stamp?: string;
    /** The topic of the graffiti comment feed, written by each user. */
    topic: string;
  };
}
```

### Events (`EVENTS`)

The library emits several events that your application can subscribe to for reacting to different stages of the comment lifecycle. Use `SwarmComment.getEmitter().on(EVENT_NAME, callback)` to subscribe.

- `EVENTS.LOADING_INIT`: ('loadingInit')
  Fired when the comment library begins its initialization process.
- `EVENTS.LOADING_PREVIOUS_MESSAGES`: ('loadingPreviousMessages')
  Fired when the library is actively loading previous messages from the comment feed.
- `EVENTS.MESSAGE_RECEIVED`: ('messageReceived')
  A new message has been successfully received from the comment feed and processed by the client.
- `EVENTS.MESSAGE_REQUEST_INITIATED`: ('messageRequestInitiated')
  The current user has initiated the process of sending a new message.
- `EVENTS.MESSAGE_REQUEST_UPLOADED`: ('messageRequestUploaded')
  The current user's message has been successfully uploaded to the feed.
- `EVENTS.MESSAGE_REQUEST_ERROR`: ('messageRequestError')
  An error occurred during the message sending process.
- `EVENTS.CRITICAL_ERROR`: ('criticalError')
  The library has encountered a critical, potentially unrecoverable error.

### Main `SwarmComment` Methods

The `SwarmComment` class instance provides the following core methods:

- `start()`: Initializes and starts the comment service, including setting up listeners and beginning to poll for messages.
- `stop()`: Stops the comment service, clears intervals, and cleans up resources.
- `getEmitter()`: Returns an event emitter instance, allowing your application to subscribe to the `EVENTS` listed above.
- `sendMessage(message: string, type: MessageType, targetMessageId?: string, id?: string)`: Initiates the process of sending a new comment message from the current user. Supports different message types including text, threads, and reactions.
- `fetchPreviousMessages()`: Manually triggers the fetching of older messages from the comment feed.
- `hasPreviousMessages()`: Returns a boolean indicating whether there are previous messages available to fetch (determined by checking the sequential feed index).
- `retrySendMessage(message: MessageData)`: Attempts to resend a message that previously encountered an error during the initial request phase (e.g., failed to write to the feed).

### Message Types

The library supports three types of messages through the `MessageType` enum:

- `MessageType.TEXT`: Regular comment messages
- `MessageType.THREAD`: Reply messages that reference a parent message via `targetMessageId`
- `MessageType.REACTION`: Emoji reactions to existing messages, also using `targetMessageId` to reference the target message

### Message State Management

The library includes robust message state handling with:

- **Automatic retry logic**: Failed message state references are automatically retried with exponential backoff
- **Ref banning**: Persistently failing references are banned after maximum retry attempts to prevent infinite loops
- **Efficient caching**: Message state data is cached to avoid redundant network requests

---

## 🚀 Usage Example (React)

Here's an example of how `swarm-comment-js` can be integrated into a React application using a custom hook (`useSwarmComment`). This hook encapsulates comment logic, state management, and event handling.

### Complete Implementation

For a full working example, check out our React integration:

**📖 [View Complete useSwarmComment Hook Implementation](https://github.com/Solar-Punk-Ltd/swarm-comment-react-example/blob/master/src/hooks/useSwarmComment.tsx)**

### Basic Usage

```typescript
import { useSwarmComment } from './hooks/useSwarmComment';
import { MessageData, MessageType } from '@solarpunkltd/comment-system';
import { v4 as uuidv4 } from 'uuid';

function CommentComponent() {
  const { messages, isLoading, sendMessage, hasPreviousMessages, loadPreviousMessages } =
    useSwarmComment(commentSettings);

  const [messages, setMessages] = useState<MessageData[]>([]);
  const reactionMessages = useMemo(
    () => messages.filter((msg) => msg.type === MessageType.REACTION && msg.targetMessageId),
    [messages],
  );

  const handleSendMessage = (text: string) => {
    sendMessage(text, MessageType.TEXT);
  };

  const reactionId = uuidv4();
  const handleReaction = (targetMessageId: string, emoji: string) => {
    sendMessage(emoji, MessageType.REACTION, targetMessageId, reactionId, reactionMessages);
  };

  const handleReply = (targetMessageId: string, replyText: string) => {
    sendMessage(replyText, MessageType.THREAD, targetMessageId);
  };

  return (
    <div className="comment-container">
      {/* Your comment UI implementation */}
      {hasPreviousMessages() && <button onClick={loadPreviousMessages}>Load Previous Messages</button>}
      {/* Message list, input field, etc. */}
    </div>
  );
}
```

---

## ⛏️ Helper Scripts

## ⚠️ Limitations

Writing to a feed index that is already taken does not result in an error, therefore reading back the comment at the
expected index is necessary as a verification of success.

---

## 💡 Future Development

- **Performance Optimizations:** Further improvements to message state handling and caching mechanisms.

---

## 📚 Further Reading & Resources

- [What are Feeds? (Official Swarm Documentation)](https://docs.ethswarm.org/docs/develop/tools-and-features/feeds#what-are-feeds)
- [Example React client](https://github.com/Solar-Punk-Ltd/swarm-comment-react-example)

---
