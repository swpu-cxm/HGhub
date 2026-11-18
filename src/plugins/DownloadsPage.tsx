import { useEffect } from "react";
import { useStore } from "../store";

/** 旧路由：统一进入「我的片库 → 缓存」。 */
export default function DownloadsPage({ onBack }: { onBack: () => void }) {
  const app = useStore();
  useEffect(() => {
    app.openLibraryCache();
    onBack();
  }, [app, onBack]);
  return null;
}
