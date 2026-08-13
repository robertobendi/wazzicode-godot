import type { Attachment, ResourceKind } from "@/types/chat";
import {
  CloseIcon,
  CubeIcon,
  DocIcon,
  ImageIcon,
  SoundIcon,
} from "@/components/shell/icons";

/**
 * A staged resource, shown above the composer (removable) and inside the sent
 * user bubble (read-only, `compact`). Image kinds render a thumbnail; others
 * show a kind icon + name + size.
 */
export default function AttachmentChip({
  attachment,
  onRemove,
  compact = false,
}: {
  attachment: Attachment;
  onRemove?: (id: string) => void;
  compact?: boolean;
}) {
  const { kind, name, size, preview } = attachment;

  return (
    <div
      className={`group flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 ${
        compact ? "py-1 pl-1.5 pr-2" : "py-1.5 pl-1.5 pr-2.5"
      }`}
      title={attachment.path}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-ink-800 text-fg-dim">
        {kind === "image" && preview ? (
          <img
            src={preview}
            alt={name}
            className="h-full w-full object-cover"
          />
        ) : (
          <KindIcon kind={kind} />
        )}
      </span>

      <span className="min-w-0">
        <span className="block max-w-[10rem] truncate text-xs text-fg">
          {name}
        </span>
        {!compact && (
          <span className="block text-[10px] text-fg-dim">
            {kind}
            {typeof size === "number" ? ` · ${humanSize(size)}` : ""}
          </span>
        )}
      </span>

      {onRemove && (
        <button
          onClick={() => onRemove(attachment.id)}
          aria-label={`Remove ${name}`}
          className="ml-0.5 shrink-0 rounded p-0.5 text-fg-dim transition-colors duration-150 hover:bg-ink-700 hover:text-fg"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

function KindIcon({ kind }: { kind: ResourceKind }) {
  switch (kind) {
    case "image":
      return <ImageIcon />;
    case "model":
      return <CubeIcon />;
    case "audio":
      return <SoundIcon />;
    default:
      return <DocIcon />;
  }
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
