/* The reviewer packet is internal and not part of the public source. */
export interface PacketDoc { slug: string; group: string; title: string; source: string; sha256: string; body: string }
export const PACKET_DOCS: readonly PacketDoc[] = [];
