import { createRoot } from "react-dom/client";
import TyphoonExperience from "../app/TyphoonExperience";
import "../app/globals.css";

const host = document.getElementById("root");
if (!host) throw new Error("Static application root was not found");

createRoot(host).render(<TyphoonExperience />);
