import { Link } from 'react-router-dom';

const Navbar = () => {
  return (
    <nav className="bg-gray-800 p-4">
      <div className="container mx-auto flex justify-between items-center">
        <Link to="/" className="text-xl font-bold">StreamApp</Link>
        <div className="space-x-4">
          <Link to="/" className="hover:text-blue-400">Home</Link>
          <Link to="/studio" className="hover:text-blue-400">Go Live</Link>
        </div>
      </div>
    </nav>
  );
};

export default Navbar; 