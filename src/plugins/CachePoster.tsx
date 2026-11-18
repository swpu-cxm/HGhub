import { useState } from "react";

export default function CachePoster({ src, title, className }: { src?: string; title: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const label = title.trim().slice(0, 2) || "作";
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        className={className}
        onError={() => setFailed(true)}
      />
    );
  }
  return <span className={className} aria-hidden="true">{label}</span>;
}