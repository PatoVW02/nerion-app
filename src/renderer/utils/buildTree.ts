import { DiskEntry } from '../types'
import { isCleanable } from './cleanable'

export interface TreeNode {
  label: string        // compressed segment(s), e.g. "Desktop/project" or "node_modules"
  path: string         // full absolute path
  isCleanable: boolean
  entry: DiskEntry | undefined
  children: TreeNode[]
  totalKB: number
}

// Build a compressed trie of cleanable directories from a flat list of DiskEntries.
// Non-cleanable single-child intermediate nodes are collapsed into a combined label.
export function buildCleanableTree(entries: DiskEntry[], rootPath: string): TreeNode[] {
  // Normalize root: '' for '/', otherwise no trailing slash
  const root = rootPath === '/' ? '' : rootPath.replace(/\/$/, '')

  // Index all entries by path
  const byPath = new Map<string, DiskEntry>()
  for (const e of entries) byPath.set(e.path, e)

  // Collect all cleanable paths
  const cleanablePaths = entries.filter(isCleanable).map((e) => e.path)
  if (cleanablePaths.length === 0) return []

  // Build a minimal trie: node = { children: Map<segment, node>, entry }
  interface TrieNode {
    children: Map<string, TrieNode>
    entry: DiskEntry | undefined
    path: string
  }

  const trieRoot: TrieNode = { children: new Map(), entry: undefined, path: root || '/' }

  for (const entry of entries) {
    const rel = entry.path.startsWith(root + '/')
      ? entry.path.slice(root.length + 1)
      : entry.path.startsWith('/')
      ? entry.path.slice(1)
      : entry.path
    const segments = rel.split('/').filter(Boolean)

    let cur = trieRoot
    let curPath = root
    for (const seg of segments) {
      curPath = curPath + '/' + seg
      if (!cur.children.has(seg)) {
        cur.children.set(seg, {
          children: new Map(),
          entry: byPath.get(curPath),
          path: curPath
        })
      }
      cur = cur.children.get(seg)!
    }
  }

  // Convert trie to TreeNode[], compressing single-child non-cleanable chains
  function convert(node: TrieNode, label: string): TreeNode {
    const entryIsCleanable = node.entry ? isCleanable(node.entry) : false
    const childNodes = [...node.children.values()]

    // Sum totalKB: use entry's sizeKB if available, else sum children
    const selfKB = node.entry?.sizeKB ?? 0

    const children = childNodes.map((c) => {
      let childLabel = [...node.children.entries()].find(([, v]) => v === c)?.[0] ?? ''
      return convert(c, childLabel)
    })

    // Sort children by totalKB desc
    children.sort((a, b) => b.totalKB - a.totalKB)

    // Leaf cleanable nodes show their own disk size (that's exactly what gets freed).
    // Any node with visible children — whether cleanable or not — shows only the
    // sum of those children, so the number always matches what's listed below it.
    const totalKB = children.length === 0
      ? (entryIsCleanable ? selfKB : 0)
      : children.reduce((s, c) => s + c.totalKB, 0)

    return {
      label,
      path: node.path,
      isCleanable: entryIsCleanable,
      entry: node.entry,
      children,
      totalKB
    }
  }

  // Start from root's children, compress single-child non-cleanable intermediate nodes
  function compress(node: TreeNode): TreeNode {
    // Recursively compress children first
    node.children = node.children.map(compress)

    // If this node is not cleanable, has exactly 1 child that is also not cleanable,
    // and has no entry of its own that we're showing as a row → collapse into child
    if (
      !node.isCleanable &&
      node.children.length === 1 &&
      !node.children[0].isCleanable
    ) {
      const child = node.children[0]
      return {
        ...child,
        label: node.label ? node.label + '/' + child.label : child.label
      }
    }
    return node
  }

  const rootChildren = [...trieRoot.children.entries()].map(([seg, child]) => {
    const raw = convert(child, seg)
    return compress(raw)
  })

  // Only keep nodes that ARE cleanable or HAVE cleanable descendants
  function hasCleanable(n: TreeNode): boolean {
    if (n.isCleanable) return true
    return n.children.some(hasCleanable)
  }

  return rootChildren
    .filter(hasCleanable)
    .sort((a, b) => b.totalKB - a.totalKB)
}
