/**
 * Picks the right starter scaffold for a project's tech stack.
 */
import { scaffoldBasicNextApp } from './scaffold';
import { scaffoldNextApp } from './scaffold-next';
import { scaffoldAngularApp } from './scaffold-angular';
import { stackKind, scaffoldIsClean } from '@/lib/config/stacks';

export async function scaffoldForStack(
  projectPath: string,
  projectId: string,
  templateType: string | null | undefined,
): Promise<void> {
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
