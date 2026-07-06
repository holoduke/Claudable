/**
 * Picks the right starter scaffold for a project's tech stack.
 */
import { scaffoldBasicNextApp } from './scaffold';
import { scaffoldNextApp } from './scaffold-next';
import { scaffoldAngularApp } from './scaffold-angular';
import { scaffoldDocumentApp } from './scaffold-document';
import { stackKind, scaffoldIsClean } from '@/lib/config/stacks';

export async function scaffoldForStack(
  projectPath: string,
  projectId: string,
  templateType: string | null | undefined,
): Promise<void> {
  // 'document' is kind-static (plain file server) but, unlike an import, it DOES
  // get a starter file: a print-ready A4 index.html.
  if (templateType === 'document') {
    return scaffoldDocumentApp(projectPath);
  }
  switch (stackKind(templateType)) {
    case 'static':
      return; // imported existing site — never scaffolded
    case 'next':
      return scaffoldNextApp(projectPath, projectId);
    case 'angular':
      return scaffoldAngularApp(projectPath, projectId);
    default:
      return scaffoldBasicNextApp(projectPath, projectId, { clean: scaffoldIsClean(templateType) });
  }
}
