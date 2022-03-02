import * as vscode from 'vscode';
import { CachingFetcher } from './cacheFetcher';
import * as path from 'path';


export class CommandListProvider implements vscode.TreeDataProvider<CommandName> {
  constructor(private fetcher: CachingFetcher) {}

  private _onDidChangeTreeData: vscode.EventEmitter<CommandName | undefined | null | void> = new vscode.EventEmitter<CommandName | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CommandName | undefined | null | void> = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CommandName): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CommandName): CommandName[] {
    if (!element) {
      return this.getCommandNames();
    }
    console.warn("CommandListProvider: Something is wrong.");
    return [];
  }

  /**
   * Given the path to package.json, read all its dependencies and devDependencies.
   */
  private getCommandNames(): CommandName[] {
    const xs = this.fetcher.getList().sort();

    const toCommandName = (name: string): CommandName => {
      return new CommandName(name, vscode.TreeItemCollapsibleState.None);
    };
    console.info(`getCommandNames(): xs = ${xs}`);
    return xs.map(toCommandName);
  }
}


class CommandName extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(label, collapsibleState);
    this.tooltip = `${this.label}`;
  }
}
