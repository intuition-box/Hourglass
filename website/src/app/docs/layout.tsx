import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

export default function Layout({ children }: LayoutProps<'/docs'>) {
  const base = baseOptions({ stackedNav: true });
  return (
    <DocsLayout tree={source.getPageTree()} {...base} sidebar={{ footer: null }}>
      {children}
    </DocsLayout>
  );
}
