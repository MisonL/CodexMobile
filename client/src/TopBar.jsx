import { Menu, Wifi } from 'lucide-react';
import { FeishuLogoIcon } from './FeishuLogoIcon.jsx';
import { CONNECTION_STATUS } from './relay-status.js';

export function TopBar({ selectedProject, connectionState, onMenu, onOpenDocs }) {
  const status = CONNECTION_STATUS[connectionState] || CONNECTION_STATUS.disconnected;
  return (
    <header className="top-bar">
      <button className="icon-button" onClick={onMenu} aria-label="打开菜单">
        <Menu size={22} />
      </button>
      <div className="top-title">
        <strong>{selectedProject?.name || 'CodexMobile'}</strong>
        <span className={`connection-status ${status.className}`}>
          <Wifi size={13} />
          {status.label}
        </span>
      </div>
      <button type="button" className="icon-button" onClick={onOpenDocs} aria-label="打开文档">
        <FeishuLogoIcon size={23} className="top-docs-logo" />
      </button>
    </header>
  );
}
