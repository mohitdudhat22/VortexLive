import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage';
import StreamStudio from './pages/StreamStudio';
import ViewStream from './pages/ViewStream';
import Navbar from './components/Navbar';

function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-900 text-white">
        <Navbar />
        <div className="container mx-auto px-4 py-8">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/studio" element={<StreamStudio />} />
            <Route path="/stream/:roomId" element={<ViewStream />} />
          </Routes>
        </div>
      </div>
    </Router>
  );
}

export default App;
