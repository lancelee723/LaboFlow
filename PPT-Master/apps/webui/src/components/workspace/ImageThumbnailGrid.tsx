import { useState } from "react"
import type { ImageItem } from "./ImageItemRow"

export function ImageThumbnailGrid({ items }: { items: ImageItem[] }) {
  const [lightbox, setLightbox] = useState<ImageItem | null>(null)
  const withThumbs = items.filter((i) => i.thumbnail_url)
  if (withThumbs.length === 0) return null

  return (
    <>
      <div className="grid grid-cols-6 gap-2">
        {withThumbs.map((item) => (
          <button
            key={item.filename}
            type="button"
            className="aspect-square rounded border overflow-hidden bg-muted hover:ring-2 hover:ring-primary/50 transition"
            onClick={() => setLightbox(item)}
            title={item.filename}
          >
            <img
              src={item.thumbnail_url!}
              alt={item.filename}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </button>
        ))}
      </div>
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox.thumbnail_url!}
            alt={lightbox.filename}
            className="max-w-[90vw] max-h-[90vh] object-contain"
          />
        </div>
      )}
    </>
  )
}
