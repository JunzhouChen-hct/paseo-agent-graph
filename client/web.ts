import { Platform } from "react-native";

// This plugin typechecks without the DOM library. Declare only what this module uses.
declare const navigator: {
  clipboard: {
    read(): Promise<
      Array<{
        types: string[];
        getType(type: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
      }>
    >;
  };
};
declare function btoa(data: string): string;

export interface ClipboardImage {
  data: string;
  mimeType: string;
}

export const canReadClipboardImage = Platform.OS === "web";

/** 读取剪贴板中的第一张图片,转成 send() 需要的 base64 形态;无图或不支持时返回 null。 */
export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (Platform.OS !== "web") return null;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      return { data: btoa(binary), mimeType: type };
    }
  } catch {
    return null;
  }
  return null;
}
