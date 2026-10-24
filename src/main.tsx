import { createRoot } from 'react-dom/client';
import Desk from '../components/desk';
import './styles.css';

const path = location.pathname.replace(/\/$/, '');
const view = path === '/mail' ? 'mail' : path === '/admin' ? 'admin' : path === '/upload' ? 'upload' : path === '/guide' ? 'guide' : 'library';
createRoot(document.getElementById('root')!).render(<Desk initialView={view} />);
