import { createRoot } from 'react-dom/client';
import Desk from '../components/desk';
import './styles.css';

const path = location.pathname.replace(/\/$/, '');
const view = document.documentElement.dataset.ownerEntry === 'true' ? 'admin' : path === '/mail' ? 'mail' : path === '/upload' ? 'upload' : path === '/guide' ? 'guide' : 'library';
createRoot(document.getElementById('root')!).render(<Desk initialView={view} />);
