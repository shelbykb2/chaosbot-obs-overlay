import { render } from 'preact';
import '../shared/overlay.css';
import './spotify.css';
import { SpotifyOverlay } from './SpotifyOverlay';

render(<SpotifyOverlay />, document.getElementById('overlay')!);
