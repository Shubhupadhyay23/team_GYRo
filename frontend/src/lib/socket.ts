import { io } from "socket.io-client";

const RAW_SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "https://mirrorless-backend-udpk.onrender.com";

function resolveUrl(url: string) {
  if (typeof window !== "undefined") {
    let resolved = url;
    if (url.includes("localhost")) {
      resolved = url.replace("localhost", window.location.hostname);
    } else if (url.includes("127.0.0.1")) {
      resolved = url.replace("127.0.0.1", window.location.hostname);
    }

    if (window.location.protocol === "https:") {
      resolved = resolved.replace(/^http:/, "https:");
    }
    return resolved;
  }
  return url;
}

const SOCKET_URL = resolveUrl(RAW_SOCKET_URL);
export const socket = io(SOCKET_URL, {
  autoConnect: false,
  transports: ["websocket", "polling"],
});
