import { io } from "socket.io-client";

const RAW_SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:8000";

function resolveUrl(url: string) {
  if (typeof window !== "undefined" && url.includes("localhost")) {
    return url.replace("localhost", window.location.hostname);
  }
  return url;
}

const SOCKET_URL = resolveUrl(RAW_SOCKET_URL);
export const socket = io(SOCKET_URL, {
  autoConnect: false,
});
