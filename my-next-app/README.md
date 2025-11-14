This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

---

## ⚙️ Tech Stack

| Layer           | Tech                                          |
| :-------------- | :-------------------------------------------- |
| Frontend        | WebRTC / MediaRecorder API                    |
| Transport       | Socket.IO (WebSocket under the hood)          |
| Backend         | Node.js (Express + Socket.IO)                 |
| Encoding / Push | FFmpeg (via child process)                    |
| Targets         | YouTube RTMP, Twitch RTMP, Facebook Live RTMP |

Browser Camera
↓
MediaRecorder (captures every 100 ms)
↓
Socket.IO (stream-data event with base64)
↓
Backend (decodes base64 → Buffer)
↓
FFmpeg stdin (one process per platform)
↓
YouTube / Twitch / Facebook RTMP servers

---

## 🚀 How It Works

### 1️⃣ Browser Capture

The browser grabs audio/video with `getUserMedia` and periodically records short chunks using the **MediaRecorder API**.

```js
const socket = io("https://your-server.com");

navigator.mediaDevices
  .getUserMedia({ video: true, audio: true })
  .then((stream) => {
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm; codecs=vp8",
    });

    recorder.ondataavailable = (e) => {
      const reader = new FileReader();
      reader.onload = () => {
        socket.emit("stream-data", reader.result.split(",")[1]); // base64 payload
      };
      reader.readAsDataURL(e.data);
    };

    recorder.start(100); // emit every 100ms
  });
// Use binary (ArrayBuffer / Buffer) not base64 — base64 adds ~33% overhead.

// Use a PassThrough or a proper Writable and pipe() to FFmpeg (Node streams handle backpressure).

// On write() returning false:

// Pause producers (emit a throttle to client), or

// Start buffering with a bounded queue and apply a drop-oldest or drop-new policy.

// On 'drain', resume: flush buffer or emit resume.

// Monitor queue length; log and alert if it grows.

// Consider lowering capture rate (bigger intervals), lowering bitrate, or using hardware encoding if CPU is the bottleneck.
```
