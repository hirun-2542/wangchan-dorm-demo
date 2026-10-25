import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate, AuthProvider } from "./auth";
import { ErrorBoundary } from "./error-boundary";
import "./styles.css";
import { applyTheme, watchSystemTheme } from "./theme";

// ธีมถูกตั้งไว้แล้วโดยสคริปต์ใน index.html ก่อน first paint — ที่นี่ซิงก์ theme-color
// ให้ตรงกับค่าจริง และเริ่มฟังการเปลี่ยนธีมของ OS เฉพาะตอนที่เลือก "ตามระบบ"
applyTheme();
watchSystemTheme();

const container = document.getElementById("root");

if (container === null) {
  throw new Error("ไม่พบองค์ประกอบรากของแอป");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <AuthGate>
          <App />
        </AuthGate>
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
);
