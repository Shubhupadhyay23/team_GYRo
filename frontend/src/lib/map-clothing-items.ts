import type { ClothingItem } from "@/types/clothing";

export interface DisplayProductItem {
  product_id?: string;
  title?: string;
  type?: string;
  cleaned_image_url?: string;
  flat_image_url?: string;
  image_url?: string;
}

/**
 * Map display_product items to ClothingItem[] for canvas overlay.
 * Only includes tops/bottoms with flat lay images (raw product photos
 * with model bodies look wrong on the body overlay).
 */
export function mapToClothingItems(items: DisplayProductItem[]): ClothingItem[] {
  const catMap: Record<string, "tops" | "bottoms"> = { top: "tops", bottom: "bottoms" };
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

  // Log each item's readiness for canvas overlay
  for (const item of items) {
    const hasType = item.type === "top" || item.type === "bottom";
    const hasFlatLay = !!(item.cleaned_image_url || item.flat_image_url);
    console.log(
      `[MirrorV2:MapClothing] Item "${item.title}" — type=${item.type ?? "MISSING"} (${hasType ? "OK" : "FILTERED"}) flatLay=${hasFlatLay ? "YES" : "NO"} cleaned=${item.cleaned_image_url ? "yes" : "no"} flat=${item.flat_image_url ? "yes" : "no"}`
    );
  }

  const result = items
    .filter((i) => i.type === "top" || i.type === "bottom")
    .map((i) => {
      let imgUrl = i.cleaned_image_url || i.flat_image_url || i.image_url || "";
      if (imgUrl && (imgUrl.startsWith("http://") || imgUrl.startsWith("https://")) && !imgUrl.includes("/api/proxy-image")) {
        imgUrl = `${apiUrl}/api/proxy-image?url=${encodeURIComponent(imgUrl)}`;
      }
      return {
        id: i.product_id || crypto.randomUUID(),
        category: catMap[i.type!],
        imageUrl: imgUrl,
        name: i.title,
      };
    });

  console.log(`[MirrorV2:MapClothing] ${items.length} items in → ${result.length} canvas items out (${items.length - result.length} filtered)`);
  return result;
}
